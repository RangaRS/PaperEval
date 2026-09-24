"""JSON API for answer keys and for evaluating answer scripts, under /api."""

from __future__ import annotations

import asyncio
import csv
import io
import logging
import re
from collections.abc import AsyncIterator
from datetime import datetime
from pathlib import PurePath
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .api import (
    EvaluationStoreDep,
    ExamStoreDep,
    OllamaDep,
    SettingsDep,
    StoreDep,
    choose_model,
    load_document,
    ndjson_response,
)
from .evaluations import (
    REPLY_LIMIT,
    AnswerStatus,
    EvaluatedAnswer,
    Evaluation,
    EvaluationNotFoundError,
    EvaluationStore,
    evaluation_events,
    grading_events,
    question_labels,
)
from .exams import Exam, ExamNotFoundError, ExamStore, Question
from .grading import Progress, document_text, format_marks, pages_without_text, progress_events, read_answer_key
from .ollama import OllamaClient, OllamaError, UnusableReplyError
from .storage import StoredDocument

logger = logging.getLogger("uvicorn.error")

router = APIRouter(prefix="/api")


class ExamIn(BaseModel):
    name: str = Field(default="", max_length=200)
    questions: list[Question] = Field(default=[], max_length=500)


class ExamSummary(BaseModel):
    id: str
    name: str
    created_at: datetime
    updated_at: datetime
    question_count: int
    total_marks: float
    # Questions that have no marks yet, which must be set before scripts can be evaluated.
    unmarked_questions: list[str]


class ExamFromDocumentRequest(BaseModel):
    document_id: str
    model: str = Field(default="", max_length=200)
    name: str = Field(default="", max_length=200)


class EvaluateRequest(BaseModel):
    exam_id: str
    model: str = Field(default="", max_length=200)


class GradeRequest(BaseModel):
    model: str = Field(default="", max_length=200)
    # The questions to mark again. Leave it out to mark every answer that has no marks yet.
    question_ids: list[str] | None = None


class EvaluationChange(BaseModel):
    student_name: str | None = Field(default=None, max_length=200)
    roll_number: str | None = Field(default=None, max_length=100)


class AnswerChange(BaseModel):
    # The student's answer, corrected by the teacher. It then needs marking again.
    answer: str | None = Field(default=None, max_length=50_000)
    # The teacher's marks for the answer; null goes back to the AI's marks.
    teacher_marks: float | None = Field(default=None, ge=0, le=1000)


class AnswerSummary(BaseModel):
    question_id: str
    number: str
    status: AnswerStatus
    marks: float | None
    max_marks: float


class EvaluationSummary(BaseModel):
    id: str
    document_id: str
    document_name: str
    exam_id: str
    exam_name: str
    model: str
    created_at: datetime
    updated_at: datetime
    student_name: str
    roll_number: str
    marks: float
    max_marks: float
    complete: bool
    answers: list[AnswerSummary]


@router.get("/exams")
def list_exams(exams: ExamStoreDep) -> list[ExamSummary]:
    return [
        ExamSummary(
            id=exam.id,
            name=exam.name,
            created_at=exam.created_at,
            updated_at=exam.updated_at,
            question_count=len(exam.questions),
            total_marks=exam.total_marks,
            unmarked_questions=_unmarked_questions(exam),
        )
        for exam in exams.list_exams()
    ]


@router.post("/exams", status_code=201)
def create_exam(body: ExamIn, exams: ExamStoreDep) -> Exam:
    """Save a new answer key."""
    return exams.create(body.name.strip() or "Untitled answer key", body.questions)


@router.post("/exams/from-document")
async def create_exam_from_document(
    body: ExamFromDocumentRequest,
    settings: SettingsDep,
    store: StoreDep,
    exams: ExamStoreDep,
    ollama: OllamaDep,
) -> StreamingResponse:
    """Make an answer key from an uploaded document with an AI model.

    Every page must have its text extracted. The text of all pages is sent to
    the model, which returns the questions as JSON. Responds with
    newline-delimited JSON events: ``start``, with how much text was sent;
    ``progress`` while the model writes its answer; then ``done`` with the new
    answer key, or ``error``, with the model's answer when it could not be used.
    """
    document = load_document(store, body.document_id)
    _require_text(document)
    if not any(page.ocr and page.ocr.text.strip() for page in document.pages):
        raise HTTPException(
            422, "No text was found on any page of this document. Extract the text again, perhaps with another model."
        )
    model = choose_model(body.model, settings)
    return ndjson_response(
        _answer_key_events(
            ollama=ollama,
            exams=exams,
            document=document,
            model=model,
            name=body.name.strip(),
            num_ctx=settings.ollama_num_ctx,
        )
    )


async def _answer_key_events(
    *, ollama: OllamaClient, exams: ExamStore, document: StoredDocument, model: str, name: str, num_ctx: int
) -> AsyncIterator[dict[str, Any]]:
    text = document_text(document)
    yield {"type": "start", "model": model, "pages": len(document.pages), "characters": len(text)}
    progress = Progress()
    reading = asyncio.ensure_future(read_answer_key(ollama, model=model, text=text, num_ctx=num_ctx, progress=progress))
    try:
        async for event in progress_events(reading, progress):
            yield event
        key = reading.result()
    except OllamaError as exc:
        logger.warning("Reading an answer key from %s with %s failed: %s", document.filename, model, exc)
        event: dict[str, Any] = {"type": "error", "message": f"Could not read the answer key: {exc}"}
        if isinstance(exc, UnusableReplyError):
            event["reply"] = exc.reply[:REPLY_LIMIT]
        yield event
        return
    finally:
        reading.cancel()
    exam = await asyncio.to_thread(
        exams.create, name or key.name or PurePath(document.filename).stem or "Answer key", key.questions
    )
    yield {"type": "done", "exam": exam.model_dump(mode="json")}


@router.get("/exams/{exam_id}")
def get_exam(exam_id: str, exams: ExamStoreDep) -> Exam:
    return _load_exam(exams, exam_id)


@router.put("/exams/{exam_id}")
def update_exam(exam_id: str, body: ExamIn, exams: ExamStoreDep) -> Exam:
    try:
        return exams.update(exam_id, body.name.strip() or "Untitled answer key", body.questions)
    except ExamNotFoundError:
        raise HTTPException(404, "Answer key not found.") from None


@router.delete("/exams/{exam_id}", status_code=204)
def delete_exam(exam_id: str, exams: ExamStoreDep, evaluations: EvaluationStoreDep) -> Response:
    """Delete an answer key, with the evaluations made with it."""
    try:
        exams.delete(exam_id)
    except ExamNotFoundError:
        raise HTTPException(404, "Answer key not found.") from None
    evaluations.delete_where(exam_id=exam_id)
    return Response(status_code=204)


@router.get("/exams/{exam_id}/results.csv")
def download_results(exam_id: str, exams: ExamStoreDep, evaluations: EvaluationStoreDep) -> Response:
    """Every evaluated script's marks for each question, as a spreadsheet."""
    exam = _load_exam(exams, exam_id)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    columns = [
        f"{label} (/{format_marks(question.max_marks)})"
        for label, question in zip(question_labels(exam.questions), exam.questions, strict=True)
    ]
    writer.writerow(["Paper", "Student", "Roll number", *columns, "Total", "Out of", "Fully marked"])
    for evaluation in sorted(evaluations.list_evaluations(exam_id=exam_id), key=_result_order):
        marks = []
        for question in exam.questions:
            answer = evaluation.answer(question.id)
            marks.append("" if answer is None or answer.marks is None else format_marks(answer.marks))
        writer.writerow(
            [
                _cell(evaluation.document_name),
                _cell(evaluation.student_name),
                _cell(evaluation.roll_number),
                *marks,
                format_marks(evaluation.marks),
                format_marks(evaluation.max_marks),
                "yes" if evaluation.complete else "no",
            ]
        )
    # The byte order mark makes Excel read the file as UTF-8.
    return Response(
        ("\ufeff" + buffer.getvalue()).encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": _attachment(f"{exam.name} results.csv")},
    )


@router.get("/evaluations")
def list_evaluations(
    evaluations: EvaluationStoreDep, document_id: str | None = None, exam_id: str | None = None
) -> list[EvaluationSummary]:
    """Evaluations with their marks, optionally only those of a document or for an answer key."""
    return [
        _summary(evaluation) for evaluation in evaluations.list_evaluations(document_id=document_id, exam_id=exam_id)
    ]


@router.post("/documents/{document_id}/evaluations")
async def evaluate_document(
    document_id: str,
    body: EvaluateRequest,
    settings: SettingsDep,
    store: StoreDep,
    exams: ExamStoreDep,
    evaluations: EvaluationStoreDep,
    ollama: OllamaDep,
) -> StreamingResponse:
    """Evaluate a student's answer script against an answer key.

    The script's text is split into the answers to the key's questions, and
    each answer is marked against the key. Responds with newline-delimited JSON
    events (see ``evaluation_events``). The evaluation replaces any earlier one
    of the same script with the same key.
    """
    document = load_document(store, document_id)
    exam = _load_exam(exams, body.exam_id)
    if not exam.questions:
        raise HTTPException(422, "The answer key has no questions.")
    unmarked = _unmarked_questions(exam)
    if unmarked:
        raise HTTPException(422, f"Set the marks for {_join(unmarked)} in the answer key first.")
    _require_text(document)
    model = choose_model(body.model, settings)
    return ndjson_response(
        evaluation_events(
            ollama=ollama,
            store=evaluations,
            document=document,
            exam=exam,
            model=model,
            num_ctx=settings.ollama_num_ctx,
            concurrency=settings.grading_concurrency,
        )
    )


@router.get("/evaluations/{evaluation_id}")
def get_evaluation(evaluation_id: str, evaluations: EvaluationStoreDep) -> Evaluation:
    return _load_evaluation(evaluations, evaluation_id)


@router.patch("/evaluations/{evaluation_id}")
def change_evaluation(evaluation_id: str, body: EvaluationChange, evaluations: EvaluationStoreDep) -> Evaluation:
    """Correct the student's name or roll number."""
    changes: dict[str, Any] = {}
    if body.student_name is not None:
        changes["student_name"] = body.student_name.strip()
    if body.roll_number is not None:
        changes["roll_number"] = body.roll_number.strip()
    try:
        return evaluations.update(evaluation_id, lambda evaluation: evaluation.model_copy(update=changes))
    except EvaluationNotFoundError:
        raise HTTPException(404, "Evaluation not found.") from None


@router.delete("/evaluations/{evaluation_id}", status_code=204)
def delete_evaluation(evaluation_id: str, evaluations: EvaluationStoreDep) -> Response:
    try:
        evaluations.delete(evaluation_id)
    except EvaluationNotFoundError:
        raise HTTPException(404, "Evaluation not found.") from None
    return Response(status_code=204)


@router.patch("/evaluations/{evaluation_id}/answers/{question_id}")
def change_answer(
    evaluation_id: str, question_id: str, body: AnswerChange, evaluations: EvaluationStoreDep
) -> Evaluation:
    """Give an answer the teacher's own marks, or correct the text of the student's answer."""

    def change(answer: EvaluatedAnswer) -> EvaluatedAnswer:
        update: dict[str, Any] = {}
        if body.answer is not None and body.answer.strip() != answer.answer:
            text = body.answer.strip()
            # The AI's marks were for the old text.
            update.update(
                answer=text,
                status="pending" if text else "unanswered",
                ai_marks=None,
                feedback="",
                error=None,
                model=None,
                graded_at=None,
            )
        if "teacher_marks" in body.model_fields_set:
            marks = body.teacher_marks
            if marks is not None and marks > answer.max_marks:
                raise HTTPException(422, f"The marks can be at most {format_marks(answer.max_marks)}.")
            update["teacher_marks"] = None if marks is None else round(marks, 2)
        return answer.model_copy(update=update)

    try:
        return evaluations.update_answer(evaluation_id, question_id, change)
    except EvaluationNotFoundError:
        raise HTTPException(404, "Evaluation or answer not found.") from None


@router.post("/evaluations/{evaluation_id}/grade")
async def grade_evaluation(
    evaluation_id: str,
    settings: SettingsDep,
    exams: ExamStoreDep,
    evaluations: EvaluationStoreDep,
    ollama: OllamaDep,
    body: GradeRequest | None = None,
) -> StreamingResponse:
    """Mark answers of an evaluation (again) with an AI model.

    Marks the given questions, or else every answer that has no marks yet, for
    example after an evaluation was stopped part way. Responds with
    newline-delimited JSON events (see ``grading_events``).
    """
    body = body or GradeRequest()
    evaluation = _load_evaluation(evaluations, evaluation_id)
    try:
        exam = exams.get(evaluation.exam_id)
    except ExamNotFoundError:
        raise HTTPException(409, "The answer key of this evaluation was deleted.") from None
    if body.question_ids is not None:
        unknown = set(body.question_ids) - {answer.question_id for answer in evaluation.answers}
        if unknown:
            raise HTTPException(404, "Answer not found.")
    model = choose_model(body.model, settings)
    return ndjson_response(
        grading_events(
            ollama=ollama,
            store=evaluations,
            evaluation=evaluation,
            exam=exam,
            model=model,
            question_ids=body.question_ids,
            num_ctx=settings.ollama_num_ctx,
            concurrency=settings.grading_concurrency,
        )
    )


def _load_exam(exams: ExamStore, exam_id: str) -> Exam:
    try:
        return exams.get(exam_id)
    except ExamNotFoundError:
        raise HTTPException(404, "Answer key not found.") from None


def _load_evaluation(evaluations: EvaluationStore, evaluation_id: str) -> Evaluation:
    try:
        return evaluations.get(evaluation_id)
    except EvaluationNotFoundError:
        raise HTTPException(404, "Evaluation not found.") from None


def _unmarked_questions(exam: Exam) -> list[str]:
    labels = question_labels(exam.questions)
    return [label for label, question in zip(labels, exam.questions, strict=True) if question.max_marks <= 0]


def _require_text(document: StoredDocument) -> None:
    missing = pages_without_text(document)
    if missing:
        pages = "page" if len(missing) == 1 else "pages"
        raise HTTPException(409, f"Extract the text of {pages} {_join([str(page) for page in missing])} first.")


def _summary(evaluation: Evaluation) -> EvaluationSummary:
    return EvaluationSummary(
        id=evaluation.id,
        document_id=evaluation.document_id,
        document_name=evaluation.document_name,
        exam_id=evaluation.exam_id,
        exam_name=evaluation.exam_name,
        model=evaluation.model,
        created_at=evaluation.created_at,
        updated_at=evaluation.updated_at,
        student_name=evaluation.student_name,
        roll_number=evaluation.roll_number,
        marks=evaluation.marks,
        max_marks=evaluation.max_marks,
        complete=evaluation.complete,
        answers=[
            AnswerSummary(
                question_id=answer.question_id,
                number=answer.number,
                status=answer.status,
                marks=answer.marks,
                max_marks=answer.max_marks,
            )
            for answer in evaluation.answers
        ],
    )


def _join(items: list[str]) -> str:
    """ "1", "1 and 2", "1, 2 and 3"."""
    return items[0] if len(items) == 1 else f"{', '.join(items[:-1])} and {items[-1]}"


def _natural_key(text: str) -> list[Any]:
    """Sorts "2" before "10"."""
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", text)]


def _result_order(evaluation: Evaluation) -> tuple[Any, ...]:
    """Scripts with a roll number first, in roll number order, then by student and file name."""
    return (
        not evaluation.roll_number,
        _natural_key(evaluation.roll_number),
        _natural_key(evaluation.student_name),
        _natural_key(evaluation.document_name),
    )


def _cell(text: str) -> str:
    """Keep spreadsheet programs from running text that starts like a formula."""
    return f"'{text}" if text.startswith(("=", "+", "-", "@", "\t", "\r")) else text


def _attachment(filename: str) -> str:
    fallback = "".join(
        char if char.isascii() and char.isprintable() and char not in '"\\' else "_" for char in filename
    )
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename)}"
