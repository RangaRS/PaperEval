"""The AI steps of marking: reading an answer key, splitting a script into answers, and marking an answer."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .exams import Question
from .ollama import OllamaClient, OllamaError
from .storage import StoredDocument

ANSWER_KEY_SYSTEM = """You turn an exam's answer key into structured data.
The text was read from scanned pages by OCR, so it may contain recognition errors. Page boundaries are marked like \
"=== Page 2 ===".
For every question give:
- number: the question number or label as printed, for example "1", "11 (a)" or "Part B 12".
- question: the question text.
- answer: the model answer or worked solution, if the text gives one.
- key: the marking scheme, for example which steps or points earn how many marks, if the text gives one.
- max_marks: the maximum marks for the question if the text states them, otherwise 0.
Copy the wording and any LaTeX maths exactly. Do not invent anything that is not in the text.
Also give the exam's title as name, or an empty string if there is none."""

ANSWER_KEY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "number": {"type": "string"},
                    "question": {"type": "string"},
                    "answer": {"type": "string"},
                    "key": {"type": "string"},
                    "max_marks": {"type": "number"},
                },
                "required": ["number", "question", "answer", "key", "max_marks"],
            },
        },
    },
    "required": ["name", "questions"],
}

SPLIT_SYSTEM = """You split a student's exam answer script into the answers to the exam's questions.
The script was read from handwritten pages by OCR, so it may contain recognition errors. Page boundaries are marked \
like "=== Page 2 ===".
- For every question the student answered, return the student's complete answer, copied exactly as written: do not \
correct, complete, summarize or reformat anything, and keep any LaTeX as it is.
- Students may answer in any order, label answers their own way (for example "Q1", "1)" or "Ans 1") and continue an \
answer on a later page. Gather every part of each answer and list the pages it is on.
- Refer to questions by the ids in the list (Q1, Q2, ...), matching answers by question number and content.
- Leave out questions the student did not answer, and anything that is not an answer, such as the student's details, \
instructions or crossed-out rough work.
- Also give the student's name and roll or register number if they are written on the script, otherwise empty \
strings."""

MARK_SYSTEM = """You are an experienced and fair examiner marking one answer from a student's exam script.
- Mark the answer against the marking key, using the model answer to judge what is correct. Give part marks for \
partly correct work where the key allows it.
- The answer was read from handwriting by OCR, so it may contain recognition errors. Don't penalize obvious OCR \
slips, but don't give credit for anything that isn't there.
- Award between 0 and the maximum marks, in steps of 0.5.
- In the feedback, say briefly which points of the key the answer meets and which it misses."""

MARK_SCHEMA: dict[str, Any] = {
    "type": "object",
    # Feedback comes first, so the model explains itself before it settles on the marks.
    "properties": {"feedback": {"type": "string"}, "marks": {"type": "number"}},
    "required": ["feedback", "marks"],
}


@dataclass
class AnswerKey:
    name: str
    questions: list[Question]


@dataclass
class SplitScript:
    student_name: str = ""
    roll_number: str = ""
    # Question id -> the student's answer and the pages it is on.
    answers: dict[str, tuple[str, list[int]]] = field(default_factory=dict)


@dataclass
class Mark:
    marks: float
    feedback: str


def pages_without_text(document: StoredDocument) -> list[int]:
    return [page.number for page in document.pages if page.ocr is None]


def document_text(document: StoredDocument) -> str:
    """The extracted text of every page, in order, with page markers."""
    return "\n\n".join(
        f"=== Page {page.number} ===\n{page.ocr.text.strip() if page.ocr else ''}" for page in document.pages
    )


def format_marks(marks: float) -> str:
    return f"{marks:g}"


async def read_answer_key(ollama: OllamaClient, *, model: str, text: str, num_ctx: int = 0) -> AnswerKey:
    """Turn the text of an answer key document into questions."""
    data = await ollama.chat_json(
        model=model,
        system=ANSWER_KEY_SYSTEM,
        prompt=f"Answer key:\n\n{text}",
        schema=ANSWER_KEY_SCHEMA,
        num_ctx=num_ctx,
    )
    data = data if isinstance(data, dict) else {}
    questions = []
    for item in data.get("questions") or []:
        if not isinstance(item, dict):
            continue
        question = Question(
            number=_text(item.get("number"))[:40],
            question=_text(item.get("question"))[:20_000],
            answer=_text(item.get("answer"))[:50_000],
            key=_text(item.get("key"))[:20_000],
            max_marks=min(max(_number(item.get("max_marks")) or 0, 0), 1000),
        )
        if question.question or question.answer:
            questions.append(question)
    if not questions:
        raise OllamaError(f"{model} found no questions in the document.")
    return AnswerKey(name=_text(data.get("name"))[:200], questions=questions)


async def split_answers(
    ollama: OllamaClient,
    *,
    model: str,
    questions: list[Question],
    script: str,
    page_count: int,
    num_ctx: int = 0,
) -> SplitScript:
    """Find each question's answer in a student's script."""
    ids = {f"Q{index}": question for index, question in enumerate(questions, start=1)}
    listing = "\n".join(
        f"{short_id} (question {question.number or short_id[1:]}, {format_marks(question.max_marks)} marks): "
        f"{_shorten(question.question, 500)}"
        for short_id, question in ids.items()
    )
    schema = {
        "type": "object",
        "properties": {
            "student_name": {"type": "string"},
            "roll_number": {"type": "string"},
            "answers": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "question": {"type": "string", "enum": list(ids)},
                        "pages": {"type": "array", "items": {"type": "integer"}},
                        "answer": {"type": "string"},
                    },
                    "required": ["question", "pages", "answer"],
                },
            },
        },
        "required": ["student_name", "roll_number", "answers"],
    }
    data = await ollama.chat_json(
        model=model,
        system=SPLIT_SYSTEM,
        prompt=f"Exam questions:\n{listing}\n\nAnswer script:\n\n{script}",
        schema=schema,
        num_ctx=num_ctx,
    )
    data = data if isinstance(data, dict) else {}
    result = SplitScript(
        student_name=_text(data.get("student_name"))[:200], roll_number=_text(data.get("roll_number"))[:100]
    )
    for item in data.get("answers") or []:
        if not isinstance(item, dict):
            continue
        question = ids.get(_text(item.get("question")).upper().replace(" ", ""))
        answer = _text(item.get("answer"))
        if question is None or not answer:
            continue
        pages = {page for page in item.get("pages") or [] if isinstance(page, int) and 1 <= page <= page_count}
        if question.id in result.answers:
            earlier, earlier_pages = result.answers[question.id]
            answer = f"{earlier}\n\n{answer}"
            pages |= set(earlier_pages)
        result.answers[question.id] = (answer, sorted(pages))
    return result


async def mark_answer(ollama: OllamaClient, *, model: str, question: Question, answer: str, num_ctx: int = 0) -> Mark:
    """Mark a student's answer to one question against its model answer and key."""
    prompt = (
        f"Question {question.number} (maximum {format_marks(question.max_marks)} marks):\n{question.question}\n\n"
        f"Model answer:\n{question.answer or '(not given)'}\n\n"
        f"Marking key:\n{question.key or '(not given: judge against the model answer)'}\n\n"
        f"Student's answer:\n{answer}"
    )
    data = await ollama.chat_json(model=model, system=MARK_SYSTEM, prompt=prompt, schema=MARK_SCHEMA, num_ctx=num_ctx)
    data = data if isinstance(data, dict) else {}
    marks = _number(data.get("marks"))
    if marks is None:
        raise OllamaError(f"{model} did not give a mark.")
    # Keep the marks within range, in steps of half a mark.
    marks = round(min(max(marks, 0), question.max_marks) * 2) / 2
    return Mark(marks=marks, feedback=_text(data.get("feedback")))


def _text(value: Any) -> str:
    if value is None or isinstance(value, dict | list):
        return ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return str(value).strip()


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None  # not NaN


def _shorten(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"
