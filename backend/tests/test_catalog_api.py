from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient


def _add(client: TestClient, collection: str, body: dict[str, Any]) -> dict[str, Any]:
    response = client.post(f"/api/catalog/{collection}", json=body)
    assert response.status_code == 201, response.text
    return response.json()[collection][-1]


def _structure(client: TestClient) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    department = _add(client, "departments", {"name": "Mathematics", "code": "MA"})
    programme = _add(
        client,
        "programmes",
        {"name": "B.Sc Mathematics", "department_id": department["id"], "term_type": "semester", "term_count": 6},
    )
    subject = _add(
        client,
        "subjects",
        {"name": "Differential Equations", "code": "MA301", "programme_id": programme["id"], "term": 3},
    )
    sitting = _add(client, "sittings", {"name": "Nov/Dec 2026", "kind": "end_term", "academic_year": "2026-27"})
    return department, programme, subject, sitting


def test_the_structure_starts_empty(client: TestClient) -> None:
    catalog = client.get("/api/catalog").json()

    assert catalog == {
        "institution": {"name": ""},
        "departments": [],
        "programmes": [],
        "subjects": [],
        "sittings": [],
    }


def test_departments_programmes_subjects_and_sittings_can_be_added_changed_and_deleted(client: TestClient) -> None:
    client.put("/api/catalog/institution", json={"name": "  Greenfield College  "})
    department, programme, subject, sitting = _structure(client)

    renamed = client.put(
        f"/api/catalog/subjects/{subject['id']}",
        json={"name": "Ordinary Differential Equations", "code": "MA301", "programme_id": programme["id"], "term": 3},
    )

    assert renamed.status_code == 200
    catalog = renamed.json()
    assert catalog["institution"]["name"] == "Greenfield College"
    assert [item["name"] for item in catalog["subjects"]] == ["Ordinary Differential Equations"]
    assert catalog["sittings"][0]["academic_year"] == "2026-27"

    assert client.delete(f"/api/catalog/sittings/{sitting['id']}").json()["sittings"] == []
    assert client.delete(f"/api/catalog/subjects/{subject['id']}").status_code == 200
    assert client.delete(f"/api/catalog/programmes/{programme['id']}").status_code == 200
    assert client.delete(f"/api/catalog/departments/{department['id']}").json()["departments"] == []


def test_the_structure_stays_consistent(client: TestClient) -> None:
    department, programme, subject, _ = _structure(client)

    beyond = client.post("/api/catalog/subjects", json={"name": "Project", "programme_id": programme["id"], "term": 7})
    nowhere = client.post("/api/catalog/programmes", json={"name": "B.A.", "department_id": "missing"})
    too_short = client.put(
        f"/api/catalog/programmes/{programme['id']}",
        json={"name": "B.Sc Mathematics", "department_id": department["id"], "term_count": 2},
    )
    in_use = client.delete(f"/api/catalog/departments/{department['id']}")
    blank = client.post("/api/catalog/departments", json={"name": "   "})

    assert beyond.status_code == 409
    assert "only 6 semesters" in beyond.json()["detail"]
    assert nowhere.status_code == 409
    assert too_short.status_code == 409
    assert in_use.status_code == 409
    assert blank.status_code == 422
    assert client.delete("/api/catalog/subjects/missing").status_code == 404


def test_an_evaluator_can_be_a_subjects_paper_in_a_sitting(client: TestClient) -> None:
    _, _, subject, sitting = _structure(client)
    placement = {"subject_id": subject["id"], "sitting_id": sitting["id"]}

    created = client.post("/api/exams", json={"name": "MA301 Nov/Dec 2026", **placement})
    loose = client.post("/api/exams", json={"name": "Quiz"}).json()

    assert created.status_code == 201
    exam = created.json()
    assert (exam["subject_id"], exam["sitting_id"]) == (subject["id"], sitting["id"])
    summaries = {summary["id"]: summary for summary in client.get("/api/exams").json()}
    assert summaries[exam["id"]]["subject_id"] == subject["id"]
    assert summaries[loose["id"]]["sitting_id"] is None

    # One paper per subject and sitting.
    assert client.post("/api/exams", json={"name": "Another", **placement}).status_code == 409
    assert client.patch(f"/api/exams/{loose['id']}/placement", json=placement).status_code == 409
    # A subject or sitting with papers can't be deleted.
    assert client.delete(f"/api/catalog/subjects/{subject['id']}").status_code == 409
    assert client.delete(f"/api/catalog/sittings/{sitting['id']}").status_code == 409

    unfiled = client.patch(f"/api/exams/{exam['id']}/placement", json={"subject_id": None, "sitting_id": None})
    filed = client.patch(f"/api/exams/{loose['id']}/placement", json=placement)

    assert unfiled.json()["subject_id"] is None
    assert filed.json()["sitting_id"] == sitting["id"]
    assert client.patch(f"/api/exams/{exam['id']}/placement", json={"subject_id": subject["id"]}).status_code == 422
    missing = {"subject_id": "missing", "sitting_id": sitting["id"]}
    assert client.patch(f"/api/exams/{exam['id']}/placement", json=missing).status_code == 422


def test_a_sample_college_can_be_added_to_an_empty_structure(client: TestClient) -> None:
    response = client.post("/api/catalog/sample")

    assert response.status_code == 200
    catalog = response.json()
    assert catalog["institution"]["name"]
    assert {department["name"] for department in catalog["departments"]} >= {"Computer Science", "Mathematics"}
    assert any(subject["code"] == "MA301" for subject in catalog["subjects"])
    assert len(catalog["sittings"]) == 3
    assert client.post("/api/catalog/sample").status_code == 409
