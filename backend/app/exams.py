"""Answer keys: an exam's questions, each with its model answer, marking key and marks.

Each answer key is stored as ``<data_dir>/exams/<id>.json``.
"""

from __future__ import annotations

import logging
import threading
import uuid
from datetime import datetime
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError, computed_field

from .storage import ID_PATTERN, utc_now, write_json_atomic

logger = logging.getLogger(__name__)


def new_question_id() -> str:
    return uuid.uuid4().hex[:12]


class Question(BaseModel):
    id: str = Field(default_factory=new_question_id, max_length=40)
    # The question's label as printed on the paper, e.g. "1", "11 (a)".
    number: str = Field(default="", max_length=40)
    question: str = Field(default="", max_length=20_000)
    # The model answer.
    answer: str = Field(default="", max_length=50_000)
    # The marking scheme: which points or steps earn how many marks.
    key: str = Field(default="", max_length=20_000)
    max_marks: float = Field(default=0, ge=0, le=1000)


class Exam(BaseModel):
    id: str
    name: str
    created_at: datetime
    updated_at: datetime
    questions: list[Question]

    @computed_field  # type: ignore[prop-decorator]
    @property
    def total_marks(self) -> float:
        return sum(question.max_marks for question in self.questions)


class ExamNotFoundError(LookupError):
    pass


class ExamStore:
    def __init__(self, data_dir: Path) -> None:
        self.root = data_dir / "exams"
        self._lock = threading.Lock()

    def list_exams(self) -> list[Exam]:
        """All answer keys, most recently changed first."""
        if not self.root.is_dir():
            return []
        exams = []
        for path in self.root.glob("*.json"):
            if not ID_PATTERN.match(path.stem):
                continue
            try:
                exams.append(Exam.model_validate_json(path.read_bytes()))
            except (OSError, ValueError, ValidationError):
                logger.warning("Skipping unreadable answer key %s", path, exc_info=True)
        exams.sort(key=lambda exam: exam.updated_at, reverse=True)
        return exams

    def get(self, exam_id: str) -> Exam:
        try:
            return Exam.model_validate_json(self._path(exam_id).read_bytes())
        except FileNotFoundError:
            raise ExamNotFoundError(exam_id) from None

    def create(self, name: str, questions: list[Question]) -> Exam:
        now = utc_now()
        exam = Exam(id=uuid.uuid4().hex, name=name, created_at=now, updated_at=now, questions=_unique_ids(questions))
        self.root.mkdir(parents=True, exist_ok=True)
        with self._lock:
            write_json_atomic(self._path(exam.id), exam)
        return exam

    def update(self, exam_id: str, name: str, questions: list[Question]) -> Exam:
        with self._lock:
            exam = self.get(exam_id)
            exam = exam.model_copy(update={"name": name, "questions": _unique_ids(questions), "updated_at": utc_now()})
            write_json_atomic(self._path(exam_id), exam)
        return exam

    def delete(self, exam_id: str) -> None:
        with self._lock:
            try:
                self._path(exam_id).unlink()
            except FileNotFoundError:
                raise ExamNotFoundError(exam_id) from None

    def _path(self, exam_id: str) -> Path:
        if not ID_PATTERN.match(exam_id):
            raise ExamNotFoundError(exam_id)
        return self.root / f"{exam_id}.json"


def _unique_ids(questions: list[Question]) -> list[Question]:
    """Give every question an id of its own, keeping existing ids where possible."""
    seen: set[str] = set()
    unique = []
    for question in questions:
        if not question.id or question.id in seen:
            question = question.model_copy(update={"id": new_question_id()})
        seen.add(question.id)
        unique.append(question)
    return unique
