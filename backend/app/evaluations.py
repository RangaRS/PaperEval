"""Evaluations: a student's answer script split into answers, each marked against an answer key.

Each evaluation is stored as ``<data_dir>/evaluations/<id>.json``.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import uuid
from collections.abc import AsyncIterator, Callable, Iterable
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ValidationError, computed_field

from .exams import Exam, Question
from .grading import Progress, document_text, mark_answer, progress_events, split_answers
from .ollama import OllamaClient, OllamaError, UnusableReplyError
from .storage import ID_PATTERN, StoredDocument, utc_now, write_json_atomic

logger = logging.getLogger("uvicorn.error")

AnswerStatus = Literal["pending", "graded", "unanswered", "error"]

# Errors that the next answer would run into as well: a bad API key, no credit, an unknown model.
_FATAL_STATUS_CODES = frozenset({401, 402, 403, 404})
# How much of a model's unusable answer to send back, to show what went wrong.
REPLY_LIMIT = 20_000


class EvaluatedAnswer(BaseModel):
    question_id: str
    # Copied from the answer key, so the evaluation still makes sense if the key changes later.
    number: str = ""
    max_marks: float = 0
    # The student's answer, as found in the script, and the pages it is on.
    answer: str = ""
    pages: list[int] = []
    status: AnswerStatus = "pending"
    ai_marks: float | None = None
    feedback: str = ""
    error: str | None = None
    model: str | None = None
    graded_at: datetime | None = None
    # Marks given by the teacher, which count instead of the AI's.
    teacher_marks: float | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def marks(self) -> float | None:
        """The marks that count, or None while the answer has not been marked."""
        if self.teacher_marks is not None:
            return self.teacher_marks
        if self.status == "unanswered":
            return 0
        if self.status == "graded":
            return self.ai_marks
        return None


class Evaluation(BaseModel):
    id: str
    document_id: str
    document_name: str
    exam_id: str
    exam_name: str
    # The model that split the script into answers.
    model: str
    created_at: datetime
    updated_at: datetime
    student_name: str = ""
    roll_number: str = ""
    answers: list[EvaluatedAnswer]

    @computed_field  # type: ignore[prop-decorator]
    @property
    def marks(self) -> float:
        return sum(answer.marks or 0 for answer in self.answers)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def max_marks(self) -> float:
        return sum(answer.max_marks for answer in self.answers)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def complete(self) -> bool:
        """Whether every answer has marks."""
        return all(answer.marks is not None for answer in self.answers)

    def answer(self, question_id: str) -> EvaluatedAnswer | None:
        return next((answer for answer in self.answers if answer.question_id == question_id), None)


class EvaluationNotFoundError(LookupError):
    pass


class EvaluationStore:
    def __init__(self, data_dir: Path) -> None:
        self.root = data_dir / "evaluations"
        # Serializes read-modify-write cycles on the evaluation files.
        self._lock = threading.Lock()

    def list_evaluations(self, *, document_id: str | None = None, exam_id: str | None = None) -> list[Evaluation]:
        """Evaluations, optionally of one document or for one answer key, newest first."""
        if not self.root.is_dir():
            return []
        evaluations = []
        for path in self.root.glob("*.json"):
            if not ID_PATTERN.match(path.stem):
                continue
            try:
                evaluation = Evaluation.model_validate_json(path.read_bytes())
            except FileNotFoundError:
                continue
            except (OSError, ValueError, ValidationError):
                logger.warning("Skipping unreadable evaluation %s", path, exc_info=True)
                continue
            if document_id is not None and evaluation.document_id != document_id:
                continue
            if exam_id is not None and evaluation.exam_id != exam_id:
                continue
            evaluations.append(evaluation)
        evaluations.sort(key=lambda evaluation: evaluation.created_at, reverse=True)
        return evaluations

    def get(self, evaluation_id: str) -> Evaluation:
        try:
            return Evaluation.model_validate_json(self._path(evaluation_id).read_bytes())
        except FileNotFoundError:
            raise EvaluationNotFoundError(evaluation_id) from None

    def add(self, evaluation: Evaluation) -> None:
        """Save a new evaluation, replacing any earlier one of the same document with the same answer key."""
        self.root.mkdir(parents=True, exist_ok=True)
        earlier = self.list_evaluations(document_id=evaluation.document_id, exam_id=evaluation.exam_id)
        with self._lock:
            write_json_atomic(self._path(evaluation.id), evaluation)
            for old in earlier:
                if old.id != evaluation.id:
                    self._path(old.id).unlink(missing_ok=True)

    def update(self, evaluation_id: str, change: Callable[[Evaluation], Evaluation]) -> Evaluation:
        """Apply ``change`` to the stored evaluation and save the result."""
        with self._lock:
            evaluation = change(self.get(evaluation_id))
            evaluation = evaluation.model_copy(update={"updated_at": utc_now()})
            write_json_atomic(self._path(evaluation_id), evaluation)
        return evaluation

    def update_answer(
        self, evaluation_id: str, question_id: str, change: Callable[[EvaluatedAnswer], EvaluatedAnswer]
    ) -> Evaluation:
        """Apply ``change`` to one answer of the stored evaluation and save the result."""

        def change_answer(evaluation: Evaluation) -> Evaluation:
            if evaluation.answer(question_id) is None:
                raise EvaluationNotFoundError(f"{evaluation_id} question {question_id}")
            answers = [change(answer) if answer.question_id == question_id else answer for answer in evaluation.answers]
            return evaluation.model_copy(update={"answers": answers})

        return self.update(evaluation_id, change_answer)

    def delete(self, evaluation_id: str) -> None:
        with self._lock:
            try:
                self._path(evaluation_id).unlink()
            except FileNotFoundError:
                raise EvaluationNotFoundError(evaluation_id) from None

    def delete_where(self, *, document_id: str | None = None, exam_id: str | None = None) -> int:
        """Delete the evaluations of a document or for an answer key. Returns how many were deleted."""
        if document_id is None and exam_id is None:
            raise ValueError("Say which evaluations to delete.")
        doomed = self.list_evaluations(document_id=document_id, exam_id=exam_id)
        with self._lock:
            for evaluation in doomed:
                self._path(evaluation.id).unlink(missing_ok=True)
        return len(doomed)

    def _path(self, evaluation_id: str) -> Path:
        if not ID_PATTERN.match(evaluation_id):
            raise EvaluationNotFoundError(evaluation_id)
        return self.root / f"{evaluation_id}.json"


async def evaluation_events(
    *,
    ollama: OllamaClient,
    store: EvaluationStore,
    document: StoredDocument,
    exam: Exam,
    model: str,
    num_ctx: int = 0,
    concurrency: int = 3,
) -> AsyncIterator[dict[str, Any]]:
    """Evaluate a student's answer script, whose pages all have their text extracted.

    Events: ``status`` when the script is being split into answers, ``split``
    with the saved evaluation once the answers are found, ``answer`` each time
    an answer has been marked, and finally ``done`` with the evaluation, or
    ``error``. An evaluation that is stopped part way keeps the marks given so
    far; ``grading_events`` can mark the rest.
    """
    yield {"type": "status", "step": "split"}
    progress = Progress()
    splitting = asyncio.ensure_future(
        split_answers(
            ollama,
            model=model,
            questions=exam.questions,
            script=document_text(document),
            page_count=len(document.pages),
            num_ctx=num_ctx,
            progress=progress,
        )
    )
    try:
        async for event in progress_events(splitting, progress):
            yield {**event, "step": "split"}
        script = splitting.result()
    except OllamaError as exc:
        logger.warning("Splitting %s into answers with %s failed: %s", document.filename, model, exc)
        event = {"type": "error", "message": f"Could not split the script into answers: {exc}"}
        if isinstance(exc, UnusableReplyError):
            event["reply"] = exc.reply[:REPLY_LIMIT]
        yield event
        return
    finally:
        splitting.cancel()

    answers = []
    for question in exam.questions:
        answer, pages = script.answers.get(question.id, ("", []))
        answers.append(
            EvaluatedAnswer(
                question_id=question.id,
                number=question.number,
                max_marks=question.max_marks,
                answer=answer,
                pages=pages,
                status="pending" if answer else "unanswered",
            )
        )
    now = utc_now()
    evaluation = Evaluation(
        id=uuid.uuid4().hex,
        document_id=document.id,
        document_name=document.filename,
        exam_id=exam.id,
        exam_name=exam.name,
        model=model,
        created_at=now,
        updated_at=now,
        student_name=script.student_name,
        roll_number=script.roll_number,
        answers=answers,
    )
    await asyncio.to_thread(store.add, evaluation)
    yield {"type": "split", "evaluation": evaluation.model_dump(mode="json")}

    async for event in grading_events(
        ollama=ollama,
        store=store,
        evaluation=evaluation,
        exam=exam,
        model=model,
        num_ctx=num_ctx,
        concurrency=concurrency,
    ):
        yield event


async def grading_events(
    *,
    ollama: OllamaClient,
    store: EvaluationStore,
    evaluation: Evaluation,
    exam: Exam,
    model: str,
    question_ids: Iterable[str] | None = None,
    num_ctx: int = 0,
    concurrency: int = 3,
) -> AsyncIterator[dict[str, Any]]:
    """Mark the answers of an evaluation, several at a time.

    Marks the given questions, or else every answer that has no marks yet.
    Marking an answer again replaces any marks the teacher gave it. Events:
    ``answer`` each time an answer has been marked (or could not be), then
    ``done`` with the evaluation, or ``error`` if marking had to stop.
    """
    questions = {question.id: question for question in exam.questions}
    if question_ids is None:
        chosen = [answer for answer in evaluation.answers if answer.marks is None]
    else:
        wanted = set(question_ids)
        chosen = [answer for answer in evaluation.answers if answer.question_id in wanted]
    limit = asyncio.Semaphore(max(1, concurrency))

    def failed(answer: EvaluatedAnswer, message: str) -> dict[str, Any]:
        # An answer that was marked before keeps its marks, with a note that marking it again failed.
        return {"error": message} if answer.status == "graded" else {"status": "error", "error": message}

    async def grade(answer: EvaluatedAnswer) -> tuple[str, dict[str, Any], OllamaError | None]:
        """Mark one answer. Returns its question id, the changes to make to it, and the error, if any."""
        question = questions.get(answer.question_id)
        if question is None:
            return answer.question_id, failed(answer, "This question is no longer in the answer key."), None
        # Keep the answer in step with the answer key, which may have changed since.
        update: dict[str, Any] = {"number": question.number, "max_marks": question.max_marks, "teacher_marks": None}
        if not answer.answer.strip():
            unanswered = {"status": "unanswered", "ai_marks": None, "feedback": "", "error": None}
            return answer.question_id, {**update, **unanswered}, None
        async with limit:
            try:
                mark = await mark_answer(ollama, model=model, question=question, answer=answer.answer, num_ctx=num_ctx)
            except OllamaError as exc:
                logger.warning("Marking question %s with %s failed: %s", question.number or question.id, model, exc)
                return answer.question_id, failed(answer, str(exc)), exc
        graded = {"status": "graded", "ai_marks": mark.marks, "feedback": mark.feedback, "error": None}
        return answer.question_id, {**update, **graded, "model": model, "graded_at": utc_now()}, None

    tasks = [asyncio.create_task(grade(answer)) for answer in chosen]
    try:
        for finished in asyncio.as_completed(tasks):
            question_id, update, error = await finished
            if error is not None and error.status_code in _FATAL_STATUS_CODES:
                # Every other answer would fail the same way, so stop here. The
                # answers that were not marked keep their earlier state.
                yield {"type": "error", "message": str(error)}
                return
            try:
                evaluation = await asyncio.to_thread(
                    store.update_answer,
                    evaluation.id,
                    question_id,
                    lambda answer, update=update: answer.model_copy(update=update),
                )
            except EvaluationNotFoundError:
                yield {"type": "error", "message": "The evaluation was deleted while it was being marked."}
                return
            answer = evaluation.answer(question_id)
            yield {"type": "answer", "answer": answer.model_dump(mode="json") if answer else None}
    finally:
        for task in tasks:
            task.cancel()
    yield {"type": "done", "evaluation": evaluation.model_dump(mode="json")}


def question_labels(questions: Iterable[Question]) -> list[str]:
    """How to refer to each question: "Q1", "Q11 (a)", or "Part B 12" as printed."""
    labels = []
    for index, question in enumerate(questions, start=1):
        number = question.number.strip()
        if not number:
            labels.append(f"Q{index}")
        elif number[0].isdigit():
            labels.append(f"Q{number}")
        else:
            labels.append(number)
    return labels
