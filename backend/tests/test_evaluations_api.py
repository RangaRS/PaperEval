from __future__ import annotations

import csv
import io
import re
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app import evaluations
from app.grading import MARK_SYSTEM, SPLIT_SYSTEM

from .helpers import FakeOllama, give_text, make_pdf, read_events, upload

QUESTIONS: list[dict[str, Any]] = [
    {
        "number": "1",
        "question": "Solve $px+qy=3z$.",
        "answer": r"$\phi\left(\frac{x}{y}, \frac{y}{z^{1/3}}\right)=0$",
        "key": "Auxiliary equations: 1 mark. Solution: 1 mark.",
        "max_marks": 2,
    },
    {
        "number": "2",
        "question": "State Fourier's theorem.",
        "answer": "A periodic function satisfying Dirichlet's conditions has a Fourier series.",
        "key": "Statement: 3 marks.",
        "max_marks": 3,
    },
    {
        "number": "3",
        "question": r"Find $a_0$ for $f(x)=x^2$ in $(-\pi, \pi)$.",
        "answer": r"$a_0 = \frac{2\pi^2}{3}$",
        "key": "Formula: 2 marks. Answer: 3 marks.",
        "max_marks": 5,
    },
]
PAGES = [
    "Name: Asha  Roll No: 21CS042\n1. $\\frac{dx}{x}=\\frac{dy}{y}$ so $\\phi(x/y)=0$",
    "3. $a_0 = \\frac{1}{\\pi}\\int_{-\\pi}^{\\pi} x^2 dx$",
    "$= \\frac{2\\pi^2}{3}$",
]
MODEL = "qwen3.5:397b-cloud"


class Examiner:
    """The fake model's answers: how it splits scripts, and the marks it gives each question."""

    def __init__(self) -> None:
        self.split: Any = {
            "student_name": "Asha",
            "roll_number": "21CS042",
            "answers": [
                {"question": "Q1", "pages": [1], "answer": r"$\frac{dx}{x}=\frac{dy}{y}$ so $\phi(x/y)=0$"},
                {"question": "Q3", "pages": [2, 3], "answer": r"$a_0 = \frac{2\pi^2}{3}$"},
            ],
        }
        # Question number -> reply, or a list of replies to give in turn.
        self.marks: dict[str, Any] = {
            "1": {"feedback": "Correct auxiliary equations and solution.", "marks": 2},
            "2": {"feedback": "Complete statement.", "marks": 3},
            "3": {"feedback": "Right formula, answer not simplified.", "marks": 2.3},
        }

    def reply(self, payload: dict[str, Any]) -> Any:
        system, prompt = (message["content"] for message in payload["messages"])
        if system == SPLIT_SYSTEM:
            return self.split
        assert system == MARK_SYSTEM
        match = re.match(r"Question (.+?) \(maximum", prompt)
        assert match
        reply = self.marks[match.group(1)]
        return reply.pop(0) if isinstance(reply, list) else reply


@pytest.fixture
def examiner(fake_ollama: FakeOllama) -> Examiner:
    examiner = Examiner()
    fake_ollama.json_reply = examiner.reply
    return examiner


@pytest.fixture
def exam(client: TestClient) -> dict[str, Any]:
    return client.post("/api/exams", json={"name": "Unit test 1", "questions": QUESTIONS}).json()


@pytest.fixture
def script(client: TestClient) -> dict[str, Any]:
    document = upload(client, make_pdf(page_count=3), filename="asha.pdf").json()
    give_text(client, document["id"], PAGES)
    return document


def evaluate(client: TestClient, document: dict[str, Any], exam: dict[str, Any]) -> list[dict[str, Any]]:
    response = client.post(f"/api/documents/{document['id']}/evaluations", json={"exam_id": exam["id"], "model": MODEL})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("application/x-ndjson")
    return read_events(response)


def grade(client: TestClient, evaluation_id: str, question_ids: list[str] | None = None) -> list[dict[str, Any]]:
    body: dict[str, Any] = {"model": MODEL}
    if question_ids is not None:
        body["question_ids"] = question_ids
    response = client.post(f"/api/evaluations/{evaluation_id}/grade", json=body)
    assert response.status_code == 200, response.text
    return read_events(response)


def marks(evaluation: dict[str, Any]) -> list[tuple[str, str, float | None]]:
    return [(answer["number"], answer["status"], answer["marks"]) for answer in evaluation["answers"]]


def test_a_script_is_split_into_answers_and_each_answer_is_marked(
    client: TestClient, fake_ollama: FakeOllama, examiner: Examiner, exam: dict[str, Any], script: dict[str, Any]
) -> None:
    events = evaluate(client, script, exam)

    assert [event["type"] for event in events] == ["status", "split", "answer", "answer", "done"]
    split = events[1]["evaluation"]
    assert split["student_name"] == "Asha"
    assert split["roll_number"] == "21CS042"
    assert split["document_name"] == "asha.pdf"
    assert split["exam_name"] == "Unit test 1"
    assert [(answer["number"], answer["status"], answer["pages"]) for answer in split["answers"]] == [
        ("1", "pending", [1]),
        ("2", "unanswered", []),
        ("3", "pending", [2, 3]),
    ]
    evaluation = events[-1]["evaluation"]
    # Marks are rounded to half marks.
    assert marks(evaluation) == [("1", "graded", 2), ("2", "unanswered", 0), ("3", "graded", 2.5)]
    assert evaluation["answers"][2]["feedback"] == "Right formula, answer not simplified."
    assert evaluation["answers"][2]["model"] == MODEL
    assert evaluation["marks"] == 4.5
    assert evaluation["max_marks"] == 10
    assert evaluation["complete"] is True
    assert client.get(f"/api/evaluations/{evaluation['id']}").json() == evaluation

    split_request, *mark_requests = fake_ollama.json_payloads()
    assert split_request["model"] == "qwen3.5:397b"
    question_schema = split_request["format"]["properties"]["answers"]["items"]["properties"]["question"]
    assert question_schema["enum"] == ["Q1", "Q2", "Q3"]
    prompt = split_request["messages"][1]["content"]
    assert "Q1 (question 1, 2 marks): Solve $px+qy=3z$." in prompt
    assert "=== Page 2 ===\n3. $a_0 = \\frac{1}{\\pi}" in prompt
    # Only the questions the student answered are sent for marking.
    assert len(mark_requests) == 2
    prompt = next(request["messages"][1]["content"] for request in mark_requests if "Question 3" in str(request))
    assert "Question 3 (maximum 5 marks):\nFind $a_0$" in prompt
    assert "Model answer:\n$a_0 = \\frac{2\\pi^2}{3}$" in prompt
    assert "Marking key:\nFormula: 2 marks. Answer: 3 marks." in prompt
    assert "Student's answer:\n$a_0 = \\frac{2\\pi^2}{3}$" in prompt


def test_marks_stay_within_the_question_s_marks(
    client: TestClient, examiner: Examiner, exam: dict[str, Any], script: dict[str, Any]
) -> None:
    examiner.marks["1"] = {"feedback": "Excellent!", "marks": 7}
    examiner.marks["3"] = {"feedback": "Nothing right.", "marks": -1}

    evaluation = evaluate(client, script, exam)[-1]["evaluation"]

    assert marks(evaluation) == [("1", "graded", 2), ("2", "unanswered", 0), ("3", "graded", 0)]


def test_the_split_is_tidied_up(
    client: TestClient, examiner: Examiner, exam: dict[str, Any], script: dict[str, Any]
) -> None:
    examiner.split = {
        "student_name": None,
        "roll_number": 42,
        "answers": [
            {"question": "q3", "pages": [2], "answer": "First part."},
            {"question": "Q7", "pages": [1], "answer": "Not a question of this exam."},
            {"question": "Q2", "pages": [], "answer": ""},
            {"question": "Q3", "pages": [9, 3], "answer": "Second part."},
            "nonsense",
        ],
    }

    split = evaluate(client, script, exam)[1]["evaluation"]

    assert split["student_name"] == ""
    assert split["roll_number"] == "42"
    assert [(answer["status"], answer["answer"], answer["pages"]) for answer in split["answers"]] == [
        ("unanswered", "", []),
        ("unanswered", "", []),
        ("pending", "First part.\n\nSecond part.", [2, 3]),
    ]


def test_evaluating_a_script_needs_its_text_and_a_complete_answer_key(
    client: TestClient, fake_ollama: FakeOllama, exam: dict[str, Any], script: dict[str, Any]
) -> None:
    def post(document_id: str, **body: Any) -> httpx.Response:
        return client.post(f"/api/documents/{document_id}/evaluations", json={"model": MODEL, **body})

    unread = upload(client, make_pdf(page_count=2)).json()
    give_text(client, unread["id"], ["1. Something"])
    response = post(unread["id"], exam_id=exam["id"])
    assert response.status_code == 409
    assert response.json()["detail"] == "Extract the text of page 2 first."

    no_marks = [{**QUESTIONS[0], "max_marks": 0}, QUESTIONS[1], {**QUESTIONS[2], "number": "", "max_marks": 0}]
    unfinished = client.post("/api/exams", json={"questions": no_marks}).json()
    response = post(script["id"], exam_id=unfinished["id"])
    assert response.status_code == 422
    assert response.json()["detail"] == "Set the marks for Q1 and Q3 in the answer key first."

    empty = client.post("/api/exams", json={"questions": []}).json()
    response = post(script["id"], exam_id=empty["id"])
    assert response.status_code == 422
    assert response.json()["detail"] == "The answer key has no questions."

    assert post(script["id"], exam_id="0" * 32).status_code == 404
    assert post("0" * 32, exam_id=exam["id"]).status_code == 404
    no_model = client.post(f"/api/documents/{script['id']}/evaluations", json={"exam_id": exam["id"]})
    assert no_model.status_code == 400
    assert fake_ollama.json_payloads() == []


def test_evaluating_a_script_again_replaces_the_earlier_evaluation(
    client: TestClient, examiner: Examiner, exam: dict[str, Any], script: dict[str, Any]
) -> None:
    evaluate(client, script, exam)
    examiner.marks["1"] = {"feedback": "Only the auxiliary equations.", "marks": 1}

    latest = evaluate(client, script, exam)[-1]["evaluation"]

    (summary,) = client.get("/api/evaluations", params={"document_id": script["id"]}).json()
    assert summary["id"] == latest["id"]
    assert summary["marks"] == 3.5
    assert summary["complete"] is True
    assert [(answer["number"], answer["marks"]) for answer in summary["answers"]] == [("1", 1), ("2", 0), ("3", 2.5)]


def test_a_failed_answer_is_reported_and_can_be_marked_later(
    client: TestClient, fake_ollama: FakeOllama, examiner: Examiner, exam: dict[str, Any], script: dict[str, Any]
) -> None:
    examiner.marks["3"] = "I would give this 3 marks."

    events = evaluate(client, script, exam)

    assert events[-1]["type"] == "done"
    evaluation = events[-1]["evaluation"]
    assert marks(evaluation) == [("1", "graded", 2), ("2", "unanswered", 0), ("3", "error", None)]
    assert "did not answer in the expected format" in evaluation["answers"][2]["error"]
    assert evaluation["complete"] is False
    assert evaluation["marks"] == 2

    examiner.marks["3"] = {"feedback": "Correct.", "marks": 5}
    requests_before = len(fake_ollama.json_payloads())
    events = grade(client, evaluation["id"])

    # Only the answer without marks is marked.
    assert len(fake_ollama.json_payloads()) == requests_before + 1
    assert [event["type"] for event in events] == ["answer", "done"]
    assert events[0]["answer"]["status"] == "graded"
    assert events[0]["answer"]["error"] is None
    assert events[-1]["evaluation"]["marks"] == 7
    assert events[-1]["evaluation"]["complete"] is True


def test_marking_stops_when_the_model_cannot_be_used(
    client: TestClient, examiner: Examiner, exam: dict[str, Any], script: dict[str, Any]
) -> None:
    refusal = httpx.Response(402, json={"error": "this model is not included in your free usage"})
    examiner.marks["1"] = refusal
    examiner.marks["3"] = refusal

    events = evaluate(client, script, exam)

    assert events[-1]["type"] == "error"
    assert "HTTP 402: this model is not included in your free usage" in events[-1]["message"]
    evaluation_id = events[1]["evaluation"]["id"]
    stored = client.get(f"/api/evaluations/{evaluation_id}").json()
    # The answers stay unmarked, ready to be marked with another model.
    assert marks(stored) == [("1", "pending", None), ("2", "unanswered", 0), ("3", "pending", None)]

    examiner.marks["1"] = {"feedback": "Correct.", "marks": 2}
    examiner.marks["3"] = {"feedback": "Correct.", "marks": 5}
    events = grade(client, evaluation_id)

    assert events[-1]["type"] == "done"
    assert events[-1]["evaluation"]["marks"] == 7


def test_splitting_errors_are_reported(
    client: TestClient, examiner: Examiner, exam: dict[str, Any], script: dict[str, Any]
) -> None:
    examiner.split = "Sorry, I can't read this."

    events = evaluate(client, script, exam)

    assert [event["type"] for event in events] == ["status", "error"]
    assert events[-1]["message"].startswith("Could not split the script into answers: qwen3.5:397b-cloud did not")
    assert client.get("/api/evaluations").json() == []


def test_rate_limited_requests_are_tried_again(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    examiner: Examiner,
    exam: dict[str, Any],
    script: dict[str, Any],
) -> None:
    monkeypatch.setattr(evaluations, "RETRY_DELAYS_SECONDS", (0.0, 0.0))
    busy = httpx.Response(429, json={"error": "too many requests"})
    examiner.marks["1"] = [busy, busy, {"feedback": "Correct.", "marks": 2}]
    examiner.marks["3"] = [busy, busy, busy]

    evaluation = evaluate(client, script, exam)[-1]["evaluation"]

    assert marks(evaluation) == [("1", "graded", 2), ("2", "unanswered", 0), ("3", "error", None)]
    assert "rate limit" in evaluation["answers"][2]["error"]


def test_the_teacher_can_change_the_marks(
    client: TestClient, examiner: Examiner, exam: dict[str, Any], script: dict[str, Any]
) -> None:
    evaluation = evaluate(client, script, exam)[-1]["evaluation"]
    question_3 = evaluation["answers"][2]["question_id"]
    url = f"/api/evaluations/{evaluation['id']}/answers/{question_3}"

    changed = client.patch(url, json={"teacher_marks": 4.5})

    assert changed.status_code == 200
    assert changed.json()["answers"][2]["teacher_marks"] == 4.5
    assert changed.json()["answers"][2]["ai_marks"] == 2.5
    assert changed.json()["answers"][2]["marks"] == 4.5
    assert changed.json()["marks"] == 6.5

    too_many = client.patch(url, json={"teacher_marks": 6})
    assert too_many.status_code == 422
    assert too_many.json()["detail"] == "The marks can be at most 5."

    restored = client.patch(url, json={"teacher_marks": None}).json()
    assert restored["answers"][2]["marks"] == 2.5
    assert restored["marks"] == 4.5

    unknown = f"/api/evaluations/{evaluation['id']}/answers/nope"
    assert client.patch(unknown, json={"teacher_marks": 1}).status_code == 404


def test_the_teacher_can_correct_an_answer_and_have_it_marked_again(
    client: TestClient, examiner: Examiner, exam: dict[str, Any], script: dict[str, Any]
) -> None:
    evaluation = evaluate(client, script, exam)[-1]["evaluation"]
    question_2 = evaluation["answers"][1]["question_id"]

    corrected = client.patch(
        f"/api/evaluations/{evaluation['id']}/answers/{question_2}",
        json={"answer": "  Every periodic function that satisfies Dirichlet's conditions has a Fourier series.  "},
    ).json()

    answer = corrected["answers"][1]
    assert answer["answer"] == "Every periodic function that satisfies Dirichlet's conditions has a Fourier series."
    assert answer["status"] == "pending"
    assert answer["marks"] is None
    assert corrected["complete"] is False

    events = grade(client, evaluation["id"], [question_2])

    assert events[-1]["type"] == "done"
    assert marks(events[-1]["evaluation"]) == [("1", "graded", 2), ("2", "graded", 3), ("3", "graded", 2.5)]


def test_marking_an_answer_again(
    client: TestClient, examiner: Examiner, exam: dict[str, Any], script: dict[str, Any]
) -> None:
    evaluation = evaluate(client, script, exam)[-1]["evaluation"]
    question_1 = evaluation["answers"][0]["question_id"]
    client.patch(f"/api/evaluations/{evaluation['id']}/answers/{question_1}", json={"teacher_marks": 1})

    # A failed attempt keeps the earlier marks, with a note about the failure.
    examiner.marks["1"] = "Not sure."
    events = grade(client, evaluation["id"], [question_1])
    answer = events[0]["answer"]
    assert (answer["status"], answer["ai_marks"], answer["teacher_marks"], answer["marks"]) == ("graded", 2, 1, 1)
    assert "did not answer in the expected format" in answer["error"]

    # A successful one replaces the AI's marks and the teacher's.
    examiner.marks["1"] = {"feedback": "Only the auxiliary equations.", "marks": 1.5}
    events = grade(client, evaluation["id"], [question_1])
    answer = events[0]["answer"]
    assert (answer["status"], answer["ai_marks"], answer["teacher_marks"], answer["marks"]) == (
        "graded",
        1.5,
        None,
        1.5,
    )
    assert answer["error"] is None
    assert answer["feedback"] == "Only the auxiliary equations."

    unknown = client.post(f"/api/evaluations/{evaluation['id']}/grade", json={"model": MODEL, "question_ids": ["x"]})
    assert unknown.status_code == 404


def test_answers_to_questions_removed_from_the_answer_key_keep_their_marks(
    client: TestClient, examiner: Examiner, exam: dict[str, Any], script: dict[str, Any]
) -> None:
    evaluation = evaluate(client, script, exam)[-1]["evaluation"]
    question_1 = evaluation["answers"][0]["question_id"]
    client.put(f"/api/exams/{exam['id']}", json={"name": exam["name"], "questions": exam["questions"][1:]})

    events = grade(client, evaluation["id"], [question_1])

    answer = events[0]["answer"]
    assert (answer["status"], answer["marks"]) == ("graded", 2)
    assert answer["error"] == "This question is no longer in the answer key."


def test_marking_again_uses_the_latest_answer_key(
    client: TestClient, fake_ollama: FakeOllama, examiner: Examiner, exam: dict[str, Any], script: dict[str, Any]
) -> None:
    evaluation = evaluate(client, script, exam)[-1]["evaluation"]
    questions = [dict(question) for question in exam["questions"]]
    questions[2].update(number="3 (a)", max_marks=10, key="Formula: 4 marks. Answer: 6 marks.")
    client.put(f"/api/exams/{exam['id']}", json={"name": exam["name"], "questions": questions})
    examiner.marks["3 (a)"] = {"feedback": "Correct.", "marks": 10}

    events = grade(client, evaluation["id"], [questions[2]["id"]])

    assert (
        "Marking key:\nFormula: 4 marks. Answer: 6 marks." in fake_ollama.json_payloads()[-1]["messages"][1]["content"]
    )
    answer = events[0]["answer"]
    assert (answer["number"], answer["max_marks"], answer["marks"]) == ("3 (a)", 10, 10)
    assert events[-1]["evaluation"]["max_marks"] == 15


def test_the_student_s_details_can_be_corrected(
    client: TestClient, examiner: Examiner, exam: dict[str, Any], script: dict[str, Any]
) -> None:
    evaluation = evaluate(client, script, exam)[-1]["evaluation"]

    changed = client.patch(f"/api/evaluations/{evaluation['id']}", json={"student_name": " Asha K "})

    assert changed.status_code == 200
    assert changed.json()["student_name"] == "Asha K"
    assert changed.json()["roll_number"] == "21CS042"
    assert client.patch(f"/api/evaluations/{'0' * 32}", json={"student_name": "A"}).status_code == 404


def test_evaluations_are_deleted_with_their_script_or_answer_key(
    client: TestClient, examiner: Examiner, exam: dict[str, Any], script: dict[str, Any]
) -> None:
    evaluation = evaluate(client, script, exam)[-1]["evaluation"]
    other_exam = client.post("/api/exams", json={"name": "Unit test 2", "questions": QUESTIONS}).json()
    evaluate(client, script, other_exam)
    assert len(client.get("/api/evaluations").json()) == 2

    assert client.delete(f"/api/exams/{exam['id']}").status_code == 204
    assert client.get(f"/api/evaluations/{evaluation['id']}").status_code == 404
    assert [summary["exam_id"] for summary in client.get("/api/evaluations").json()] == [other_exam["id"]]

    assert client.delete(f"/api/documents/{script['id']}").status_code == 204
    assert client.get("/api/evaluations").json() == []


def test_an_evaluation_can_be_deleted(
    client: TestClient, examiner: Examiner, exam: dict[str, Any], script: dict[str, Any]
) -> None:
    evaluation = evaluate(client, script, exam)[-1]["evaluation"]

    assert client.delete(f"/api/evaluations/{evaluation['id']}").status_code == 204
    assert client.get(f"/api/evaluations/{evaluation['id']}").status_code == 404
    assert client.delete(f"/api/evaluations/{evaluation['id']}").status_code == 404


def test_the_results_can_be_downloaded_as_a_spreadsheet(
    client: TestClient, examiner: Examiner, exam: dict[str, Any], script: dict[str, Any]
) -> None:
    evaluate(client, script, exam)
    other = upload(client, make_pdf(page_count=1), filename="ravi.pdf").json()
    give_text(client, other["id"], ["Roll No: 21CS007\n2. Fourier's theorem..."])
    examiner.split = {
        "student_name": '=HYPERLINK("http://example.com")',
        "roll_number": "21CS007",
        "answers": [{"question": "Q2", "pages": [1], "answer": "Fourier's theorem..."}],
    }
    examiner.marks["2"] = {"feedback": "Partly right.", "marks": 1.5}
    evaluate(client, other, exam)

    response = client.get(f"/api/exams/{exam['id']}/results.csv")

    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.headers["content-disposition"] == (
        "attachment; filename=\"Unit test 1 results.csv\"; filename*=UTF-8''Unit%20test%201%20results.csv"
    )
    assert response.content.startswith("\ufeff".encode())
    rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"))))
    assert rows == [
        ["Paper", "Student", "Roll number", "Q1 (/2)", "Q2 (/3)", "Q3 (/5)", "Total", "Out of", "Fully marked"],
        # In roll number order, with text that looks like a formula made harmless.
        ["ravi.pdf", '\'=HYPERLINK("http://example.com")', "21CS007", "0", "1.5", "0", "1.5", "10", "yes"],
        ["asha.pdf", "Asha", "21CS042", "2", "0", "2.5", "4.5", "10", "yes"],
    ]
    assert client.get(f"/api/exams/{'0' * 32}/results.csv").status_code == 404
