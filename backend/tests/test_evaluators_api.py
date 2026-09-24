"""Evaluators own their key file and their answer papers."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.evaluations import Evaluation, EvaluationStore, adopt_marked_papers
from app.exams import ExamStore
from app.grading import ANSWER_KEY_SYSTEM
from app.storage import DocumentStore

from .helpers import FakeOllama, give_text, make_client, make_pdf, read_events

KEY_TEXT = "1. What is 2 + 2? (1 mark) Answer: 4. All or nothing."
KEY_REPLY = {
    "name": "Unit test 1",
    "questions": [
        {"number": "1", "question": "What is 2 + 2?", "answer": "4", "key": "All or nothing", "max_marks": 1}
    ],
}


def new_evaluator(client: TestClient, name: str = "") -> dict[str, Any]:
    return client.post("/api/exams", json={"name": name}).json()


def upload_to(client: TestClient, exam: dict[str, Any], role: str, filename: str, pages: int = 1) -> Any:
    return client.post(
        "/api/documents",
        files={"file": (filename, make_pdf(page_count=pages), "application/pdf")},
        data={"exam_id": exam["id"], "role": role},
    )


def read_key(client: TestClient, exam: dict[str, Any], model: str = "m") -> list[dict[str, Any]]:
    response = client.post(f"/api/exams/{exam['id']}/read-key", json={"model": model})
    assert response.status_code == 200, response.text
    return [event for event in read_events(response) if event["type"] != "progress"]


def test_a_new_evaluator_is_untitled_and_empty(client: TestClient) -> None:
    exam = new_evaluator(client)

    assert exam["name"] == "Untitled evaluator"
    assert exam["questions"] == []
    assert exam["key_document_id"] is None
    (summary,) = client.get("/api/exams").json()
    assert summary["key_document_id"] is None


def test_the_key_file_and_answer_papers_belong_to_the_evaluator(client: TestClient) -> None:
    exam = new_evaluator(client, "Unit test 1")

    key = upload_to(client, exam, "key", "key.pdf", pages=2)
    paper = upload_to(client, exam, "script", "asha.pdf")
    loose = client.post("/api/documents", files={"file": ("loose.pdf", make_pdf(), "application/pdf")})

    assert key.status_code == 201
    assert (key.json()["exam_id"], key.json()["role"]) == (exam["id"], "key")
    assert (paper.json()["exam_id"], paper.json()["role"]) == (exam["id"], "script")
    assert (loose.json()["exam_id"], loose.json()["role"]) == (None, None)
    assert client.get(f"/api/exams/{exam['id']}").json()["key_document_id"] == key.json()["id"]
    listed = {
        document["filename"]: (document["exam_id"], document["role"])
        for document in client.get("/api/documents").json()
    }
    assert listed == {"key.pdf": (exam["id"], "key"), "asha.pdf": (exam["id"], "script"), "loose.pdf": (None, None)}


def test_a_new_key_file_replaces_the_old_one_which_is_kept(client: TestClient) -> None:
    exam = new_evaluator(client)
    first = upload_to(client, exam, "key", "first.pdf").json()

    second = upload_to(client, exam, "key", "second.pdf").json()

    assert client.get(f"/api/exams/{exam['id']}").json()["key_document_id"] == second["id"]
    kept = client.get(f"/api/documents/{first['id']}").json()
    assert (kept["exam_id"], kept["role"]) == (None, None)


def test_a_document_uploaded_earlier_can_be_used(client: TestClient) -> None:
    exam = new_evaluator(client)
    document = client.post("/api/documents", files={"file": ("key.pdf", make_pdf(), "application/pdf")}).json()

    assigned = client.patch(f"/api/documents/{document['id']}", json={"exam_id": exam["id"], "role": "key"})

    assert assigned.status_code == 200
    assert (assigned.json()["exam_id"], assigned.json()["role"]) == (exam["id"], "key")
    assert client.get(f"/api/exams/{exam['id']}").json()["key_document_id"] == document["id"]

    released = client.patch(f"/api/documents/{document['id']}", json={"exam_id": None, "role": None})

    assert (released.json()["exam_id"], released.json()["role"]) == (None, None)
    assert client.get(f"/api/exams/{exam['id']}").json()["key_document_id"] is None


def test_documents_are_only_given_to_evaluators_that_exist(client: TestClient) -> None:
    exam = new_evaluator(client)
    pdf = {"file": ("x.pdf", make_pdf(), "application/pdf")}

    assert client.post("/api/documents", files=pdf, data={"exam_id": exam["id"]}).status_code == 422
    assert client.post("/api/documents", files=pdf, data={"role": "key"}).status_code == 422
    assert client.post("/api/documents", files=pdf, data={"exam_id": "0" * 32, "role": "key"}).status_code == 404
    assert client.post("/api/documents", files=pdf, data={"exam_id": exam["id"], "role": "other"}).status_code == 422
    assert client.get("/api/documents").json() == []


def test_deleting_the_key_file_leaves_the_evaluator_without_one(client: TestClient) -> None:
    exam = new_evaluator(client)
    key = upload_to(client, exam, "key", "key.pdf").json()

    assert client.delete(f"/api/documents/{key['id']}").status_code == 204

    assert client.get(f"/api/exams/{exam['id']}").json()["key_document_id"] is None


def test_deleting_an_evaluator_deletes_its_files_and_marks(client: TestClient, fake_ollama: FakeOllama) -> None:
    exam = new_evaluator(client)
    upload_to(client, exam, "key", "key.pdf")
    paper = upload_to(client, exam, "script", "asha.pdf").json()
    other = new_evaluator(client, "Other")
    kept = upload_to(client, other, "script", "ravi.pdf").json()
    loose = client.post("/api/documents", files={"file": ("loose.pdf", make_pdf(), "application/pdf")}).json()

    assert client.delete(f"/api/exams/{exam['id']}").status_code == 204

    assert client.get(f"/api/documents/{paper['id']}").status_code == 404
    assert {document["id"] for document in client.get("/api/documents").json()} == {kept["id"], loose["id"]}


def test_the_key_is_read_into_the_evaluator(client: TestClient, fake_ollama: FakeOllama) -> None:
    exam = new_evaluator(client)
    key = upload_to(client, exam, "key", "Maths unit test.pdf").json()
    give_text(client, key["id"], [KEY_TEXT])
    fake_ollama.json_reply = lambda payload: KEY_REPLY

    events = read_key(client, exam)

    assert [event["type"] for event in events] == ["start", "done"]
    updated = events[-1]["exam"]
    assert updated["id"] == exam["id"]
    # An untitled evaluator takes the exam's title.
    assert updated["name"] == "Unit test 1"
    assert [(q["number"], q["question"], q["max_marks"]) for q in updated["questions"]] == [("1", "What is 2 + 2?", 1)]
    assert updated["key_document_id"] == key["id"]
    assert client.get(f"/api/exams/{exam['id']}").json() == updated
    (payload,) = fake_ollama.json_payloads()
    assert payload["messages"][0]["content"] == ANSWER_KEY_SYSTEM
    assert KEY_TEXT in payload["messages"][1]["content"]


def test_reading_the_key_again_replaces_the_questions_and_keeps_the_name(
    client: TestClient, fake_ollama: FakeOllama
) -> None:
    exam = client.post(
        "/api/exams",
        json={"name": "Maths, class 10 B", "questions": [{"number": "9", "question": "Old", "max_marks": 3}]},
    ).json()
    key = upload_to(client, exam, "key", "key.pdf").json()
    give_text(client, key["id"], [KEY_TEXT])
    fake_ollama.json_reply = lambda payload: KEY_REPLY

    updated = read_key(client, exam)[-1]["exam"]

    assert updated["name"] == "Maths, class 10 B"
    assert [question["number"] for question in updated["questions"]] == ["1"]


def test_reading_the_key_needs_a_key_file_with_text(client: TestClient, fake_ollama: FakeOllama) -> None:
    exam = new_evaluator(client)

    response = client.post(f"/api/exams/{exam['id']}/read-key", json={"model": "m"})
    assert response.status_code == 409
    assert response.json()["detail"] == "Upload the question paper with its answer key first."

    key = upload_to(client, exam, "key", "key.pdf", pages=2).json()
    response = client.post(f"/api/exams/{exam['id']}/read-key", json={"model": "m"})
    assert response.status_code == 409
    assert response.json()["detail"] == "Extract the text of pages 1 and 2 first."

    give_text(client, key["id"], ["", " "])
    response = client.post(f"/api/exams/{exam['id']}/read-key", json={"model": "m"})
    assert response.status_code == 422

    assert client.post(f"/api/exams/{'0' * 32}/read-key", json={"model": "m"}).status_code == 404
    assert fake_ollama.json_payloads() == []


@pytest.mark.parametrize("reply", [{"name": "", "questions": []}, "No questions here, sorry."])
def test_a_key_that_cannot_be_read_leaves_the_evaluator_as_it_was(
    client: TestClient, fake_ollama: FakeOllama, reply: Any
) -> None:
    exam = client.post(
        "/api/exams", json={"name": "Unit test", "questions": [{"question": "Kept", "max_marks": 1}]}
    ).json()
    key = upload_to(client, exam, "key", "key.pdf").json()
    give_text(client, key["id"], [KEY_TEXT])
    fake_ollama.json_reply = lambda payload: reply

    events = read_key(client, exam)

    assert [event["type"] for event in events] == ["start", "error"]
    assert "reply" in events[-1]
    assert [question["question"] for question in client.get(f"/api/exams/{exam['id']}").json()["questions"]] == ["Kept"]


def test_papers_marked_before_evaluators_existed_join_their_evaluator(settings: Settings) -> None:
    # Uploads and marks made by a version without evaluators: the documents belong to none.
    with make_client(settings, FakeOllama()) as client:
        exam = new_evaluator(client, "Unit test 1")
        other = new_evaluator(client, "Unit test 2")
        ids = {
            name: client.post(
                "/api/documents", files={"file": (f"{name}.pdf", make_pdf(page_count=1), "application/pdf")}
            ).json()["id"]
            for name in ("marked", "remarked", "unmarked", "orphan")
        }
    evaluations = EvaluationStore(settings.data_dir)

    def evaluate(name: str, exam_id: str, when: str) -> None:
        created = datetime.fromisoformat(when)
        evaluation = Evaluation(
            id=uuid.uuid4().hex,
            document_id=ids[name],
            document_name=f"{name}.pdf",
            exam_id=exam_id,
            exam_name="",
            model="m",
            created_at=created,
            updated_at=created,
            answers=[],
        )
        evaluations.add(evaluation)

    evaluate("marked", exam["id"], "2026-01-01T00:00:00+00:00")
    evaluate("remarked", exam["id"], "2026-01-01T00:00:00+00:00")
    evaluate("remarked", other["id"], "2026-02-01T00:00:00+00:00")
    evaluate("orphan", "0" * 32, "2026-01-01T00:00:00+00:00")  # Its answer key was deleted.

    # Starting the new version puts each marked paper into the evaluator of its latest marks.
    with make_client(settings, FakeOllama()) as client:
        documents = client.get("/api/documents").json()
    placed = {document["filename"]: (document["exam_id"], document["role"]) for document in documents}

    assert placed == {
        "marked.pdf": (exam["id"], "script"),
        "remarked.pdf": (other["id"], "script"),
        "unmarked.pdf": (None, None),
        "orphan.pdf": (None, None),
    }
    # Papers already in an evaluator stay where they are.
    stores = DocumentStore(settings.data_dir), ExamStore(settings.data_dir), evaluations
    assert adopt_marked_papers(*stores) == 0
