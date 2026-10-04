"""The AI steps of marking: reading an answer key, splitting a script into answers, and marking an answer.

Each step asks a model for JSON. Some servers ignore the JSON schema a request
gives, and models word their JSON in many ways, so the prompts spell out the
shape wanted and the answers are read leniently. An answer that is of no use
is asked for once more, without a schema.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any, TypeVar

from .exams import Question
from .ollama import OllamaClient, UnusableReplyError, parse_json_answer, with_retries
from .paper import ROOT_ID, Group, QuestionRef
from .storage import StoredDocument

logger = logging.getLogger("uvicorn.error")

T = TypeVar("T")

ANSWER_KEY_SYSTEM = """You turn the text of an exam's answer key into JSON.
The text was read from scanned pages by OCR, so it may contain recognition errors. Page boundaries are marked like \
"=== Page 2 ===".
For every question in the text, give:
- number: its number or label as printed, for example "1", "11 (a)" or "Part B 12".
- question: the question.
- answer: its model answer or worked solution, if the text gives one, otherwise "".
- key: its marking scheme, for example which steps or points earn how many marks, if the text gives one, otherwise \
"".
- max_marks: its maximum marks if the text states them, otherwise 0.
Keep the paper's layout. Give a section ("Part B") or a question with sub-questions ("11" with "(a)" and "(b)") as \
an object with:
- number: its label, for example "Part B" or "11".
- question: its instructions or the text its sub-questions share, for example "Answer any five questions.".
- rule: which of its parts count. "all" when every part must be answered; "any 1" for a choice between parts, like \
"11 (a) OR 11 (b)"; "any 5" for "answer any five"; "any 6, at least 2 from each" when the parts are sections and \
some must come from each.
- parts: its questions or sub-questions, in the same shape.
Copy the wording and any LaTeX maths exactly. Do not invent anything that is not in the text.
Reply with only a JSON object, in this shape:
{"name": "the exam's title, or an empty string", "questions": [{"number": "1", "question": "...", "answer": "...", \
"key": "...", "max_marks": 2}, {"number": "11", "question": "", "rule": "any 1", "parts": [{"number": "11 (a)", \
"question": "...", "answer": "...", "key": "...", "max_marks": 13}, {"number": "11 (b)", "question": "...", \
"answer": "...", "key": "...", "max_marks": 13}]}]}"""


def _key_item_schema(depth: int) -> dict[str, Any]:
    """A question, or a section or question with parts nested up to ``depth`` levels deep."""
    properties: dict[str, Any] = {
        "number": {"type": "string"},
        "question": {"type": "string"},
        "answer": {"type": "string"},
        "key": {"type": "string"},
        "max_marks": {"type": "number"},
    }
    if depth > 0:
        properties["rule"] = {"type": "string"}
        properties["parts"] = {"type": "array", "items": _key_item_schema(depth - 1)}
    return {
        "type": "object",
        "properties": properties,
        "required": ["number", "question", "answer", "key", "max_marks"],
    }


ANSWER_KEY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "questions": {"type": "array", "items": _key_item_schema(3)},
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
strings.
Reply with only a JSON object, in this shape:
{"student_name": "", "roll_number": "", "answers": [{"question": "Q1", "pages": [1], "answer": "..."}]}"""

MARK_SYSTEM = """You are an experienced and fair examiner marking one answer from a student's exam script.
- Mark the answer against the marking key, using the model answer to judge what is correct. Give part marks for \
partly correct work where the key allows it.
- The answer was read from handwriting by OCR, so it may contain recognition errors. Don't penalize obvious OCR \
slips, but don't give credit for anything that isn't there.
- Award between 0 and the maximum marks, in steps of 0.5.
- In the feedback, say briefly which points of the key the answer meets and which it misses.
Reply with only a JSON object, in this shape: {"feedback": "...", "marks": 1.5}"""

MARK_SCHEMA: dict[str, Any] = {
    "type": "object",
    # Feedback comes first, so the model explains itself before it settles on the marks.
    "properties": {"feedback": {"type": "string"}, "marks": {"type": "number"}},
    "required": ["feedback", "marks"],
}

# The names models use for each field, after _normalized().
_NAME_FIELDS = ("name", "title", "exam_name", "exam_title", "exam", "paper", "subject")
_LIST_FIELDS = ("questions", "question_list", "items", "answer_key", "answers", "data", "results")
_NUMBER_FIELDS = (
    "number",
    "no",
    "num",
    "q_no",
    "qno",
    "question_no",
    "question_number",
    "question_num",
    "label",
    "sno",
    "s_no",
    "id",
)
_QUESTION_FIELDS = ("question", "question_text", "text", "q", "problem", "prompt")
_ANSWER_FIELDS = (
    "answer",
    "model_answer",
    "solution",
    "expected_answer",
    "answer_text",
    "correct_answer",
    "model_solution",
    "worked_solution",
)
_KEY_FIELDS = (
    "key",
    "marking_key",
    "marking_scheme",
    "mark_scheme",
    "scheme",
    "rubric",
    "key_points",
    "marking",
    "marking_guide",
    "marking_criteria",
    "criteria",
)
_MAX_MARKS_FIELDS = ("max_marks", "marks", "maximum_marks", "max_mark", "total_marks", "mark", "points", "max_points")
_RULE_FIELDS = ("rule", "choice", "choices", "attempt", "instructions", "instruction")
_PART_FIELDS = ("parts", "sub_questions", "subquestions", "questions", "items")
_SPLIT_QUESTION_FIELDS = ("question", "question_id", "id", "q", "question_number", "number", "qno", "q_no")
_SPLIT_ANSWER_FIELDS = ("answer", "student_answer", "text", "response", "content", "answer_text")
_PAGE_FIELDS = ("pages", "page", "page_numbers", "page_no", "page_number")
_STUDENT_FIELDS = ("student_name", "name", "student", "candidate_name", "candidate")
_ROLL_FIELDS = (
    "roll_number",
    "roll_no",
    "roll",
    "register_number",
    "register_no",
    "reg_no",
    "registration_number",
    "student_id",
)
_MARKS_FIELDS = ("marks", "score", "marks_awarded", "awarded_marks", "awarded", "mark", "points", "total")
_FEEDBACK_FIELDS = ("feedback", "comment", "comments", "reason", "justification", "explanation", "remarks")
_NUMBER = re.compile(r"\d+(?:\.\d+)?")
_SIGNED_NUMBER = re.compile(r"-?\d+(?:\.\d+)?")


@dataclass
class AnswerKey:
    name: str
    questions: list[Question]
    # The paper's sections, sub-questions and choices.
    structure: Group | None = None


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


@dataclass
class Progress:
    """How far a model has got with an answer, to show while it writes."""

    attempt: int = 1
    # Characters of the answer received so far.
    received: int = 0

    def add(self, piece: str) -> None:
        self.received += len(piece)


def pages_without_text(document: StoredDocument) -> list[int]:
    return [page.number for page in document.pages if page.ocr is None]


def document_text(document: StoredDocument) -> str:
    """The extracted text of every page, in order, with page markers."""
    return "\n\n".join(
        f"=== Page {page.number} ===\n{page.ocr.text.strip() if page.ocr else ''}" for page in document.pages
    )


def format_marks(marks: float) -> str:
    return f"{marks:g}"


async def progress_events(task: asyncio.Future[Any], progress: Progress) -> AsyncIterator[dict[str, Any]]:
    """While ``task`` runs, report how much of its answer the model has written, twice a second."""
    reported = (1, 0)
    while True:
        done, _ = await asyncio.wait({task}, timeout=0.5)
        if done:
            return
        if (progress.attempt, progress.received) != reported:
            reported = (progress.attempt, progress.received)
            yield {"type": "progress", "attempt": progress.attempt, "characters": progress.received}


async def read_answer_key(
    ollama: OllamaClient, *, model: str, text: str, num_ctx: int = 0, progress: Progress | None = None
) -> AnswerKey:
    """Turn the text of an answer key document into questions.

    Raises UnusableReplyError, with the model's answer, if it finds no questions.
    """
    key, reply = await _ask(
        ollama,
        model=model,
        system=ANSWER_KEY_SYSTEM,
        prompt=f"Answer key:\n\n{text}",
        schema=ANSWER_KEY_SCHEMA,
        parse=parse_answer_key,
        good=lambda key: bool(key.questions),
        num_ctx=num_ctx,
        progress=progress,
    )
    if not key.questions:
        raise UnusableReplyError(f"{model} found no questions in the text.", reply=reply)
    return key


def parse_answer_key(data: Any) -> AnswerKey:
    """Read the questions from a model's JSON, whatever shape it used."""
    questions, nodes = _questions(_items(data))
    return AnswerKey(name=_title(data)[:200], questions=questions, structure=_root(nodes))


def _title(data: Any, depth: int = 0) -> str:
    """The exam's title: a name field of the JSON, or of an object inside it ({"exam": {"title": ...}})."""
    if not isinstance(data, dict) or depth > 2:
        return ""
    fields = _normalized(data)
    for name in _NAME_FIELDS:
        value = fields.get(name)
        if isinstance(value, str | int | float) and not isinstance(value, bool) and str(value).strip():
            return str(value).strip()
    for value in data.values():
        title = _title(value, depth + 1)
        if title:
            return title
    return ""


async def split_answers(
    ollama: OllamaClient,
    *,
    model: str,
    questions: list[Question],
    script: str,
    page_count: int,
    num_ctx: int = 0,
    progress: Progress | None = None,
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
    # A script with hardly any text may really have no answers; any other should have some.
    written = len(re.sub(r"=== Page \d+ ===|\s", "", script)) > 40
    result, _ = await _ask(
        ollama,
        model=model,
        system=SPLIT_SYSTEM,
        prompt=f"Exam questions:\n{listing}\n\nAnswer script:\n\n{script}",
        schema=schema,
        parse=lambda data: _parse_split(data, ids, page_count),
        good=lambda result: bool(result.answers) or not written,
        num_ctx=num_ctx,
        progress=progress,
    )
    return result


async def mark_answer(ollama: OllamaClient, *, model: str, question: Question, answer: str, num_ctx: int = 0) -> Mark:
    """Mark a student's answer to one question against its model answer and key."""
    prompt = (
        f"Question {question.number} (maximum {format_marks(question.max_marks)} marks):\n{question.question}\n\n"
        f"Model answer:\n{question.answer or '(not given)'}\n\n"
        f"Marking key:\n{question.key or '(not given: judge against the model answer)'}\n\n"
        f"Student's answer:\n{answer}"
    )
    mark, _ = await _ask(
        ollama,
        model=model,
        system=MARK_SYSTEM,
        prompt=prompt,
        schema=MARK_SCHEMA,
        parse=lambda data: _parse_mark(data, question.max_marks),
        num_ctx=num_ctx,
    )
    return mark


async def _ask(
    ollama: OllamaClient,
    *,
    model: str,
    system: str,
    prompt: str,
    schema: dict[str, Any],
    parse: Callable[[Any], T],
    good: Callable[[T], bool] = lambda result: True,
    num_ctx: int = 0,
    progress: Progress | None = None,
) -> tuple[T, str]:
    """Ask for JSON, read it with ``parse``, and return the result with the model's answer.

    An answer that is not JSON, that ``parse`` rejects with a ValueError, or
    whose result is not ``good`` is asked for once more without the schema. The
    second result is returned even if it is not good; an unusable second
    answer raises UnusableReplyError.
    """
    for attempt, attempt_schema in ((1, schema), (2, None)):
        if progress is not None:
            progress.attempt, progress.received = attempt, 0
        answer = await with_retries(
            lambda attempt_schema=attempt_schema: ollama.chat_text(
                model=model,
                system=system,
                prompt=prompt,
                schema=attempt_schema,
                num_ctx=num_ctx,
                on_text=progress.add if progress is not None else None,
            )
        )
        try:
            result = parse(parse_json_answer(answer, model))
        except UnusableReplyError as exc:
            problem: UnusableReplyError = exc
        except ValueError as exc:
            problem = UnusableReplyError(f"{model} {exc}.", reply=answer.text)
        else:
            if good(result) or attempt == 2:
                return result, answer.text
            problem = UnusableReplyError(f"{model} gave an empty answer.", reply=answer.text)
        if attempt == 2:
            raise problem
        logger.warning("%s Asking %s again without a JSON schema. It answered: %.500s", problem, model, answer.text)
    raise AssertionError("unreachable")


def _items(data: Any, depth: int = 0) -> list[dict[str, Any]]:
    """The list of objects in a model's JSON: the whole of it, or a list inside it, wherever the model put it."""
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if not isinstance(data, dict) or depth > 3:
        return []
    fields = _normalized(data)
    for name in _LIST_FIELDS:
        if isinstance(fields.get(name), list | dict):
            items = _items(fields[name], depth + 1)
            if items:
                return items
    values = [value for value in data.values() if isinstance(value, dict)]
    if values and len(values) == len(data) and all(_looks_like_question(value) for value in values):
        # {"1": {...}, "2": {...}}: questions keyed by their numbers.
        return [{"number": key, **value} for key, value in data.items()]
    for value in data.values():
        if isinstance(value, list | dict):
            items = _items(value, depth + 1)
            if items:
                return items
    return []


def _looks_like_question(item: dict[str, Any]) -> bool:
    fields = _normalized(item)
    return _pick(fields, *_QUESTION_FIELDS, *_ANSWER_FIELDS) is not None


def _questions(
    items: list[dict[str, Any]], *, parent: str = "", stem: str = "", depth: int = 0
) -> tuple[list[Question], list[Group | QuestionRef]]:
    """Questions from the model's objects, with the paper's layout of sections ("Part A") and parts ("11" with
    "(a)" and "(b)") and the rules saying which of them count.

    Each question's text starts with the text of the sections and questions it is part of, so that it can be
    marked on its own.
    """
    questions: list[Question] = []
    nodes: list[Group | QuestionRef] = []
    for item in items:
        fields = _normalized(item)
        number = _text(_pick(fields, *_NUMBER_FIELDS))
        text = _text(_pick(fields, *_QUESTION_FIELDS))
        answer = _text(_pick(fields, *_ANSWER_FIELDS))
        parts = next((fields[name] for name in _PART_FIELDS if isinstance(fields.get(name), list)), None)
        if parts and not answer and depth < 3:
            is_question = bool(number) and number[0].isdigit()
            label = _join_numbers(parent, number) if is_question else parent
            inner, inner_nodes = _questions(
                [part for part in parts if isinstance(part, dict)],
                parent=label,
                stem="\n\n".join(filter(None, (stem, text))),
                depth=depth + 1,
            )
            if inner:
                questions.extend(inner)
                nodes.append(
                    Group(
                        label=(label if is_question else number)[:100],
                        text=text[:20_000],
                        children=inner_nodes,
                        **_rule(_text(_pick(fields, *_RULE_FIELDS)), text, inner_nodes),
                    )
                )
                continue
        if not text and not answer:
            continue
        question = Question(
            number=_join_numbers(parent, number)[:40],
            question="\n\n".join(filter(None, (stem, text)))[:20_000],
            answer=answer[:50_000],
            key=_text(_pick(fields, *_KEY_FIELDS))[:20_000],
            max_marks=_marks(_pick(fields, *_MAX_MARKS_FIELDS)),
        )
        questions.append(question)
        nodes.append(QuestionRef(question_id=question.id))
    return questions, nodes


def _root(nodes: list[Group | QuestionRef]) -> Group:
    """The whole paper. When the model gave it as one unnamed group, that group is the paper."""
    if len(nodes) == 1 and isinstance(nodes[0], Group) and not nodes[0].label:
        return nodes[0].model_copy(update={"id": ROOT_ID})
    return Group(id=ROOT_ID, children=nodes)


_COUNT_WORDS = {
    word: number
    for number, word in enumerate(
        "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen".split()
    )
}
_COUNT = r"(\d+|" + "|".join(_COUNT_WORDS) + r")"


def _count(word: str) -> int:
    return int(word) if word.isdigit() else _COUNT_WORDS[word]


def _rule(rule: str, instructions: str, children: list[Group | QuestionRef]) -> dict[str, Any]:
    """Which of a group's parts count, from the rule the model gave ("any 5", "either/or") or else from the printed
    instructions ("Answer any five questions", "Answer five questions, choosing one from each module")."""
    parts = sum(isinstance(child, Group) for child in children)
    for text, given in ((rule, True), (instructions, False)):
        lowered = " ".join(text.lower().split())
        if not lowered:
            continue
        each = re.search(_COUNT + r"\s+(?:full\s+)?(?:questions?\s+)?from\s+each\b", lowered)
        min_each = _count(each.group(1)) if each and parts else 0
        chosen = re.search(r"\b(?:any|answer|attempt)\s+(?:any\s+)?" + _COUNT + r"\b", lowered)
        if chosen and (given or "any" in lowered or min_each):
            count = max(_count(chosen.group(1)), 1)
            pool = sum(len(child.children) for child in children if isinstance(child, Group)) if min_each else 0
            if count < (pool or len(children)) or min_each:
                return {"rule": "any", "count": count, "min_each": min_each}
            return {"rule": "all"}
        if given and re.search(r"\b(either|or|choice|choose)\b", lowered):
            return {"rule": "any", "count": 1}
        if given:
            return {"rule": "all"}
    return {"rule": "all"}


def _join_numbers(parent: str, number: str) -> str:
    """ "11" and "a" make "11 (a)"; a part numbered in full, like "11 (a)", is kept as it is."""
    if not parent:
        return number
    if not number:
        return parent
    if number.replace(" ", "").lower().startswith(parent.replace(" ", "").lower()):
        return number
    return f"{parent} ({number.strip('()')})"


def _parse_split(data: Any, ids: dict[str, Question], page_count: int) -> SplitScript:
    fields = _normalized(data) if isinstance(data, dict) else {}
    result = SplitScript(
        student_name=_text(_pick(fields, *_STUDENT_FIELDS))[:200],
        roll_number=_text(_pick(fields, *_ROLL_FIELDS))[:100],
    )
    by_number = {_compact(question.number): question for question in ids.values() if question.number}
    for item in _items(data):
        item_fields = _normalized(item)
        question = _question_for(_text(_pick(item_fields, *_SPLIT_QUESTION_FIELDS)), ids, by_number)
        answer = _text(_pick(item_fields, *_SPLIT_ANSWER_FIELDS))
        if question is None or not answer:
            continue
        pages = {page for page in _pages(_pick(item_fields, *_PAGE_FIELDS)) if 1 <= page <= page_count}
        if question.id in result.answers:
            earlier, earlier_pages = result.answers[question.id]
            answer = f"{earlier}\n\n{answer}"
            pages |= set(earlier_pages)
        result.answers[question.id] = (answer, sorted(pages))
    return result


def _question_for(reference: str, ids: dict[str, Question], by_number: dict[str, Question]) -> Question | None:
    """The question an answer refers to: by its id ("Q3"), its printed number ("11 (a)"), or its place ("3")."""
    compact = reference.upper().replace(" ", "")
    if compact in ids:
        return ids[compact]
    printed = _compact(re.sub(r"^\s*(question|ans(wer)?|q)\s*[.:)-]?\s*", "", reference, flags=re.IGNORECASE))
    if printed in by_number:
        return by_number[printed]
    if printed.isdigit():
        return ids.get(f"Q{int(printed)}")
    return None


def _compact(label: str) -> str:
    return re.sub(r"[^0-9a-z]", "", label.lower())


def _parse_mark(data: Any, max_marks: float) -> Mark:
    if isinstance(data, int | float) and not isinstance(data, bool):
        marks, feedback = float(data), ""
    else:
        fields = _normalized(data) if isinstance(data, dict) else {}
        raw = _pick(fields, *_MARKS_FIELDS)
        if isinstance(raw, int | float) and not isinstance(raw, bool):
            marks = float(raw)
        else:
            # "3", "3/5" or "3 marks".
            match = _SIGNED_NUMBER.search(_text(raw)) if raw is not None else None
            if match is None:
                raise ValueError("did not give a mark")
            marks = float(match.group())
        feedback = _text(_pick(fields, *_FEEDBACK_FIELDS))
    # Keep the marks within range, in steps of half a mark.
    return Mark(marks=round(min(max(marks, 0), max_marks) * 2) / 2, feedback=feedback)


def _normalized(item: dict[str, Any]) -> dict[str, Any]:
    """The item with its keys in lower case with underscores: "Question No." becomes "question_no"."""
    return {re.sub(r"[^a-z0-9]+", "_", str(key).lower()).strip("_"): value for key, value in item.items()}


def _pick(fields: dict[str, Any], *names: str) -> Any:
    """The value of the first of these fields that the item has and that is not empty."""
    for name in names:
        value = fields.get(name)
        if value is not None and value != "" and value != [] and value != {}:
            return value
    return None


def _text(value: Any) -> str:
    if value is None or isinstance(value, bool):
        return ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, list):
        return "\n".join(text for text in (_text(item) for item in value) if text)
    if isinstance(value, dict):
        inner = _pick(_normalized(value), "text", "content", "value", "description")
        if inner is not None:
            return _text(inner)
        return "\n".join(f"{key}: {_text(item)}" for key, item in value.items() if _text(item))
    return str(value).strip()


def _marks(value: Any) -> float:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int | float):
        number = float(value)
    else:
        match = _NUMBER.search(_text(value))
        number = float(match.group()) if match else 0
    return min(max(number, 0), 1000) if number == number else 0  # not NaN


def _pages(value: Any) -> list[int]:
    if isinstance(value, bool) or value is None:
        return []
    if isinstance(value, int):
        return [value]
    if isinstance(value, list):
        return [page for item in value for page in _pages(item)]
    return [int(number) for number in re.findall(r"\d+", str(value))]


def _shorten(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"
