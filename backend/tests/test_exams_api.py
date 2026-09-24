from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient

from app.config import Settings
from app.grading import ANSWER_KEY_SYSTEM

from .helpers import FakeOllama, give_text, make_pdf, upload

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


def test_invalid_answer_keys_are_refused(client: TestClient) -> None:
    unknown = "0" * 32

    assert client.post("/api/exams", json={"questions": [{"max_marks": -1}]}).status_code == 422
    assert client.get("/api/exams/not-an-id").status_code == 404
    assert client.get(f"/api/exams/{unknown}").status_code == 404
    assert client.put(f"/api/exams/{unknown}", json={"questions": QUESTIONS}).status_code == 404
    assert client.delete(f"/api/exams/{unknown}").status_code == 404


def test_an_answer_key_can_be_read_from_a_document(client: TestClient, fake_ollama: FakeOllama) -> None:
    document = upload(client, make_pdf(page_count=2), filename="key.pdf").json()
    give_text(client, document["id"], ["1. Solve $px+qy=3z$. (2 marks)", "Answer: $\\phi(x/y, y/z)=0$"])
    # Models often leave the backslashes of LaTeX unescaped.
    fake_ollama.json_reply = lambda payload: (
        '{"name": "Unit test 1", "questions": ['
        '{"number": "1", "question": "Solve $\\frac{x}{2}$.", "answer": "$\\theta = 0$", '
        '"key": "1 mark per step", "max_marks": 2},'
        '{"number": 2, "question": "", "answer": "", "key": "", "max_marks": 0}]}'
    )

    response = client.post(
        "/api/exams/from-document", json={"document_id": document["id"], "model": "qwen3.5:397b-cloud"}
    )

    assert response.status_code == 201
    exam = response.json()
    assert exam["name"] == "Unit test 1"
    # The empty question is left out.
    assert [(q["number"], q["question"], q["answer"], q["key"], q["max_marks"]) for q in exam["questions"]] == [
        ("1", r"Solve $\frac{x}{2}$.", r"$\theta = 0$", "1 mark per step", 2)
    ]
    assert client.get(f"/api/exams/{exam['id']}").json() == exam
    (payload,) = fake_ollama.json_payloads()
    assert payload["model"] == "qwen3.5:397b"
    assert payload["messages"][0]["content"] == ANSWER_KEY_SYSTEM
    prompt = payload["messages"][1]["content"]
    assert "=== Page 1 ===\n1. Solve $px+qy=3z$. (2 marks)" in prompt
    assert "=== Page 2 ===\nAnswer: $\\phi(x/y, y/z)=0$" in prompt


def test_an_answer_key_is_named_after_its_document_if_it_has_no_title(
    client: TestClient, fake_ollama: FakeOllama
) -> None:
    document = upload(client, make_pdf(page_count=1), filename="Unit test 3.pdf").json()
    give_text(client, document["id"], ["1. What is 2 + 2? Answer: 4 (1 mark)"])
    fake_ollama.json_reply = lambda payload: {
        "name": "",
        "questions": [{"number": "1", "question": "What is 2 + 2?", "answer": "4", "key": "", "max_marks": 1}],
    }

    exam = client.post("/api/exams/from-document", json={"document_id": document["id"], "model": "m"}).json()

    assert exam["name"] == "Unit test 3"


def test_reading_an_answer_key_needs_the_text_of_every_page(client: TestClient, fake_ollama: FakeOllama) -> None:
    document = upload(client, make_pdf(page_count=3)).json()
    give_text(client, document["id"], ["1. What is 2 + 2?"])

    response = client.post("/api/exams/from-document", json={"document_id": document["id"], "model": "m"})

    assert response.status_code == 409
    assert response.json()["detail"] == "Extract the text of pages 2 and 3 first."
    assert fake_ollama.json_payloads() == []


def test_a_document_without_questions_is_reported(client: TestClient, fake_ollama: FakeOllama) -> None:
    document = upload(client, make_pdf(page_count=1)).json()
    give_text(client, document["id"], ["A shopping list"])
    fake_ollama.json_reply = lambda payload: {"name": "", "questions": []}

    response = client.post("/api/exams/from-document", json={"document_id": document["id"], "model": "m"})

    assert response.status_code == 502
    assert response.json()["detail"] == "Could not read the answer key: m found no questions in the document."
    assert client.get("/api/exams").json() == []


def test_reading_an_answer_key_needs_a_model(client: TestClient) -> None:
    document = upload(client, make_pdf(page_count=1)).json()
    give_text(client, document["id"], ["1. What is 2 + 2?"])

    response = client.post("/api/exams/from-document", json={"document_id": document["id"]})

    assert response.status_code == 400
    assert "No model selected" in response.json()["detail"]
