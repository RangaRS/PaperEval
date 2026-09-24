from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.grading import ANSWER_KEY_SCHEMA, ANSWER_KEY_SYSTEM, Progress, progress_events

from .helpers import FakeOllama, give_text, make_pdf, read_events, upload

QUESTIONS: list[dict[str, Any]] = [
    {
        "number": "1",
        "question": "Solve $px+qy=3z$.",
        "answer": r"The auxiliary equations are $\frac{dx}{x}=\frac{dy}{y}=\frac{dz}{3z}$.",
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
]


def test_answer_keys_can_be_created_changed_and_deleted(client: TestClient) -> None:
    created = client.post("/api/exams", json={"name": "Unit test 1", "questions": QUESTIONS})

    assert created.status_code == 201
    exam = created.json()
    assert exam["name"] == "Unit test 1"
    assert exam["total_marks"] == 5
    assert [question["number"] for question in exam["questions"]] == ["1", "2"]
    assert len({question["id"] for question in exam["questions"]}) == 2
    (summary,) = client.get("/api/exams").json()
    assert summary["id"] == exam["id"]
    assert summary["question_count"] == 2
    assert summary["total_marks"] == 5
    assert summary["unmarked_questions"] == []

    first = {**exam["questions"][0], "max_marks": 4}
    updated = client.put(f"/api/exams/{exam['id']}", json={"name": "Unit test 2", "questions": [first]})

    assert updated.status_code == 200
    assert updated.json()["name"] == "Unit test 2"
    assert updated.json()["total_marks"] == 4
    # Questions keep their ids, which evaluations refer to.
    assert updated.json()["questions"][0]["id"] == first["id"]
    assert client.get(f"/api/exams/{exam['id']}").json() == updated.json()

    assert client.delete(f"/api/exams/{exam['id']}").status_code == 204
    assert client.get(f"/api/exams/{exam['id']}").status_code == 404
    assert client.get("/api/exams").json() == []


def test_an_answer_key_is_stored_as_json(client: TestClient, settings: Settings) -> None:
    exam = client.post("/api/exams", json={"name": "Unit test 1", "questions": QUESTIONS}).json()

    stored = json.loads((settings.data_dir / "exams" / f"{exam['id']}.json").read_text(encoding="utf-8"))

    assert stored["name"] == "Unit test 1"
    assert stored["questions"][0] == {"id": exam["questions"][0]["id"], **QUESTIONS[0]}


def test_every_question_gets_an_id_of_its_own(client: TestClient) -> None:
    questions = [{"id": "same", "question": "A"}, {"id": "same", "question": "B"}, {"question": "C"}]

    exam = client.post("/api/exams", json={"questions": questions}).json()

    ids = [question["id"] for question in exam["questions"]]
    assert ids[0] == "same"
    assert len(set(ids)) == 3
    assert exam["name"] == "Untitled answer key"
    # Scripts can only be evaluated once every question has marks.
    (summary,) = client.get("/api/exams").json()
    assert summary["unmarked_questions"] == ["Q1", "Q2", "Q3"]


def test_invalid_answer_keys_are_refused(client: TestClient) -> None:
    unknown = "0" * 32

    assert client.post("/api/exams", json={"questions": [{"max_marks": -1}]}).status_code == 422
    assert client.get("/api/exams/not-an-id").status_code == 404
    assert client.get(f"/api/exams/{unknown}").status_code == 404
    assert client.put(f"/api/exams/{unknown}", json={"questions": QUESTIONS}).status_code == 404
    assert client.delete(f"/api/exams/{unknown}").status_code == 404


def key_document(client: TestClient, texts: list[str], filename: str = "key.pdf") -> dict[str, Any]:
    document = upload(client, make_pdf(page_count=len(texts)), filename=filename).json()
    give_text(client, document["id"], texts)
    return document


def read_key(client: TestClient, document: dict[str, Any], model: str = "qwen3.5:397b-cloud") -> list[dict[str, Any]]:
    response = client.post("/api/exams/from-document", json={"document_id": document["id"], "model": model})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("application/x-ndjson")
    # How much the model has written so far depends on timing; the other events don't.
    return [event for event in read_events(response) if event["type"] != "progress"]


def summary(exam: dict[str, Any]) -> list[tuple[Any, ...]]:
    return [(q["number"], q["question"], q["answer"], q["key"], q["max_marks"]) for q in exam["questions"]]


def test_an_answer_key_can_be_read_from_a_document(client: TestClient, fake_ollama: FakeOllama) -> None:
    pages = ["1. Solve $px+qy=3z$. (2 marks)", "Answer: $\\phi(x/y, y/z)=0$"]
    document = key_document(client, pages)
    # Models often leave the backslashes of LaTeX unescaped.
    fake_ollama.json_reply = lambda payload: (
        '{"name": "Unit test 1", "questions": ['
        '{"number": "1", "question": "Solve $\\frac{x}{2}$.", "answer": "$\\theta = 0$", '
        '"key": "1 mark per step", "max_marks": 2},'
        '{"number": 2, "question": "", "answer": "", "key": "", "max_marks": 0}]}'
    )

    events = read_key(client, document)

    assert [event["type"] for event in events] == ["start", "done"]
    text = "=== Page 1 ===\n" + pages[0] + "\n\n=== Page 2 ===\n" + pages[1]
    assert events[0] == {"type": "start", "model": "qwen3.5:397b-cloud", "pages": 2, "characters": len(text)}
    exam = events[1]["exam"]
    assert exam["name"] == "Unit test 1"
    # The empty question is left out.
    assert summary(exam) == [("1", r"Solve $\frac{x}{2}$.", r"$\theta = 0$", "1 mark per step", 2)]
    assert client.get(f"/api/exams/{exam['id']}").json() == exam
    (payload,) = fake_ollama.json_payloads()
    assert payload["model"] == "qwen3.5:397b"
    assert payload["format"] == ANSWER_KEY_SCHEMA
    assert payload["messages"][0]["content"] == ANSWER_KEY_SYSTEM
    assert payload["messages"][1]["content"] == f"Answer key:\n\n{text}"


def test_an_answer_key_is_named_after_its_document_if_it_has_no_title(
    client: TestClient, fake_ollama: FakeOllama
) -> None:
    document = key_document(client, ["1. What is 2 + 2? Answer: 4 (1 mark)"], filename="Unit test 3.pdf")
    fake_ollama.json_reply = lambda payload: {
        "name": "",
        "questions": [{"number": "1", "question": "What is 2 + 2?", "answer": "4", "key": "", "max_marks": 1}],
    }

    exam = read_key(client, document)[-1]["exam"]

    assert exam["name"] == "Unit test 3"


@pytest.mark.parametrize(
    "reply",
    [
        # A bare list, other field names, and marks written as text.
        [
            {
                "no": 1,
                "question_text": "What is 2 + 2?",
                "model_answer": "4",
                "marking_scheme": "All or nothing",
                "marks": "1 mark",
            }
        ],
        # Sections, like Part A and Part B.
        {
            "title": "Unit test",
            "sections": [
                {
                    "section": "Part A",
                    "questions": [
                        {
                            "number": "1",
                            "question": "What is 2 + 2?",
                            "answer": "4",
                            "key": "All or nothing",
                            "max_marks": 1,
                        }
                    ],
                }
            ],
        },
        # The questions inside another object.
        {
            "exam": {
                "title": "Unit test",
                "questions": [
                    {
                        "Question No.": "1",
                        "Question": "What is 2 + 2?",
                        "Answer": "4",
                        "Marking Key": "All or nothing",
                        "Marks": 1,
                    }
                ],
            }
        },
        # Questions keyed by their numbers.
        {"1": {"question": "What is 2 + 2?", "answer": "4", "rubric": ["All or nothing"], "max_marks": 1}},
        # JSON in a code block, after some words.
        'Here is the answer key:\n```json\n{"questions": [{"number": "1", "question": "What is 2 + 2?", '
        '"answer": "4", "key": "All or nothing", "max_marks": 1}]}\n```',
    ],
)
def test_answer_keys_in_other_shapes_are_read(client: TestClient, fake_ollama: FakeOllama, reply: Any) -> None:
    document = key_document(client, ["1. What is 2 + 2? (1 mark) Answer: 4. All or nothing."])
    fake_ollama.json_reply = lambda payload: reply

    exam = read_key(client, document)[-1]["exam"]

    assert summary(exam) == [("1", "What is 2 + 2?", "4", "All or nothing", 1)]


def test_sub_questions_become_questions_of_their_own(client: TestClient, fake_ollama: FakeOllama) -> None:
    document = key_document(client, ["11. Answer both parts. (a) Define a group. [3] (b) Give an example. [2]"])
    fake_ollama.json_reply = lambda payload: {
        "questions": [
            {
                "number": "11",
                "question": "Answer both parts.",
                "parts": [
                    {"number": "a", "question": "Define a group.", "answer": "A set with an operation...", "marks": 3},
                    {"number": "(b)", "question": "Give an example.", "answer": "The integers under +", "marks": 2},
                ],
            }
        ]
    }

    exam = read_key(client, document)[-1]["exam"]

    assert summary(exam) == [
        ("11 (a)", "Answer both parts.\n\nDefine a group.", "A set with an operation...", "", 3),
        ("11 (b)", "Answer both parts.\n\nGive an example.", "The integers under +", "", 2),
    ]


def test_an_answer_without_questions_is_asked_for_again_without_a_schema(
    client: TestClient, fake_ollama: FakeOllama
) -> None:
    document = key_document(client, ["1. What is 2 + 2? (1 mark) Answer: 4"])
    good = {"questions": [{"number": "1", "question": "What is 2 + 2?", "answer": "4", "key": "", "max_marks": 1}]}
    # Some models give up inside a schema, and return an empty list.
    fake_ollama.json_reply = lambda payload: {"name": "", "questions": []} if "format" in payload else good

    events = read_key(client, document)

    assert [event["type"] for event in events] == ["start", "done"]
    assert summary(events[-1]["exam"]) == [("1", "What is 2 + 2?", "4", "", 1)]
    first, second = fake_ollama.json_payloads()
    assert first["format"] == ANSWER_KEY_SCHEMA
    assert "format" not in second
    assert second["messages"] == first["messages"]


def test_a_model_that_finds_no_questions_is_reported_with_its_answer(
    client: TestClient, fake_ollama: FakeOllama
) -> None:
    document = key_document(client, ["A shopping list: eggs, milk."])
    fake_ollama.json_reply = lambda payload: {"name": "", "questions": []}

    events = read_key(client, document, model="m")

    assert [event["type"] for event in events] == ["start", "error"]
    assert events[-1]["message"] == "Could not read the answer key: m found no questions in the text."
    assert events[-1]["reply"] == '{"name": "", "questions": []}'
    assert len(fake_ollama.json_payloads()) == 2
    assert client.get("/api/exams").json() == []


def test_an_answer_that_is_not_json_is_reported_with_it(client: TestClient, fake_ollama: FakeOllama) -> None:
    document = key_document(client, ["1. What is 2 + 2?"])
    fake_ollama.json_reply = lambda payload: "I'm sorry, I can't find any questions here."

    error = read_key(client, document, model="m")[-1]

    assert error["type"] == "error"
    assert "m did not answer in the expected format" in error["message"]
    assert error["reply"] == "I'm sorry, I can't find any questions here."


def test_reading_an_answer_key_needs_the_text_of_every_page(client: TestClient, fake_ollama: FakeOllama) -> None:
    document = upload(client, make_pdf(page_count=3)).json()
    give_text(client, document["id"], ["1. What is 2 + 2?"])

    response = client.post("/api/exams/from-document", json={"document_id": document["id"], "model": "m"})

    assert response.status_code == 409
    assert response.json()["detail"] == "Extract the text of pages 2 and 3 first."
    assert fake_ollama.json_payloads() == []


def test_pages_without_any_text_are_not_sent(client: TestClient, fake_ollama: FakeOllama) -> None:
    document = key_document(client, ["", "  \n "])

    response = client.post("/api/exams/from-document", json={"document_id": document["id"], "model": "m"})

    assert response.status_code == 422
    assert response.json()["detail"].startswith("No text was found on any page of this document.")
    assert fake_ollama.json_payloads() == []


def test_reading_an_answer_key_needs_a_model(client: TestClient) -> None:
    document = key_document(client, ["1. What is 2 + 2?"])

    response = client.post("/api/exams/from-document", json={"document_id": document["id"]})

    assert response.status_code == 400
    assert "No model selected" in response.json()["detail"]


def test_progress_is_reported_while_the_model_writes() -> None:
    async def run() -> tuple[list[dict[str, Any]], str]:
        progress = Progress()

        async def write() -> str:
            for _ in range(3):
                progress.add("0123456789")
                await asyncio.sleep(0.3)
            return "finished"

        task = asyncio.ensure_future(write())
        events = [event async for event in progress_events(task, progress)]
        return events, task.result()

    events, result = asyncio.run(run())

    assert result == "finished"
    assert events
    assert all(event["type"] == "progress" and event["attempt"] == 1 for event in events)
    assert [event["characters"] for event in events] == sorted({event["characters"] for event in events})
