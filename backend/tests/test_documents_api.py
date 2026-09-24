from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings

from .helpers import FakeOllama, make_client, make_image, make_pdf, upload


def test_uploading_a_pdf_creates_one_page_per_pdf_page(client: TestClient) -> None:
    response = upload(client, make_pdf(page_count=3), "exam.pdf")

    assert response.status_code == 201
    document = response.json()
    assert document["filename"] == "exam.pdf"
    assert document["kind"] == "pdf"
    assert [page["number"] for page in document["pages"]] == [1, 2, 3]
    first = document["pages"][0]
    assert (first["width"], first["height"]) == (850, 1100)  # 8.5 x 11 in at 100 dpi
    assert first["image_url"] == f"/api/documents/{document['id']}/pages/1/image"
    assert first["ocr"] is None


def test_page_images_and_thumbnails_are_served(client: TestClient) -> None:
    document = upload(client, make_pdf(page_count=2)).json()
    page = document["pages"][1]

    image = client.get(page["image_url"])
    thumbnail = client.get(page["thumbnail_url"])

    assert image.status_code == 200
    assert image.headers["content-type"] == "image/png"
    assert Image.open(io.BytesIO(image.content)).size == (850, 1100)
    assert thumbnail.headers["content-type"] == "image/jpeg"
    width, height = Image.open(io.BytesIO(thumbnail.content)).size
    assert width <= 240 and height <= 320


def test_uploading_a_photo_keeps_it_as_jpeg(client: TestClient) -> None:
    document = upload(client, make_image("JPEG", size=(640, 480)), "photo.jpg").json()

    assert document["kind"] == "image"
    assert len(document["pages"]) == 1
    image = client.get(document["pages"][0]["image_url"])
    assert image.headers["content-type"] == "image/jpeg"


def test_documents_are_listed_newest_first(client: TestClient) -> None:
    first = upload(client, make_pdf(page_count=1), "first.pdf").json()
    second = upload(client, make_image("PNG"), "second.png").json()

    listed = client.get("/api/documents").json()

    assert [document["id"] for document in listed] == [second["id"], first["id"]]
    assert client.get(f"/api/documents/{first['id']}").json() == first


def test_documents_survive_a_restart(settings: Settings, fake_ollama: FakeOllama) -> None:
    with make_client(settings, fake_ollama) as client:
        document = upload(client, make_pdf(page_count=1)).json()

    with make_client(settings, fake_ollama) as client:
        assert [listed["id"] for listed in client.get("/api/documents").json()] == [document["id"]]


def test_deleting_a_document(client: TestClient) -> None:
    document = upload(client, make_pdf(page_count=1)).json()

    assert client.delete(f"/api/documents/{document['id']}").status_code == 204
    assert client.get(f"/api/documents/{document['id']}").status_code == 404
    assert client.get(document["pages"][0]["image_url"]).status_code == 404
    assert client.delete(f"/api/documents/{document['id']}").status_code == 404
    assert client.get("/api/documents").json() == []


def test_unsupported_files_are_rejected(client: TestClient) -> None:
    response = upload(client, b"plain text, not a document", "notes.txt")

    assert response.status_code == 415
    assert "Unsupported file type" in response.json()["detail"]


def test_empty_files_are_rejected(client: TestClient) -> None:
    assert upload(client, b"", "empty.pdf").status_code == 400


def test_files_over_the_size_limit_are_rejected(client: TestClient) -> None:
    response = upload(client, b"%PDF-" + b"0" * (1024 * 1024), "huge.pdf")  # limit is 1 MB

    assert response.status_code == 413


def test_files_with_too_many_pages_are_rejected(client: TestClient) -> None:
    response = upload(client, make_pdf(page_count=6))  # limit is 5

    assert response.status_code == 422
    assert "6 pages" in response.json()["detail"]
    assert client.get("/api/documents").json() == []


def test_windows_paths_are_stripped_from_filenames(client: TestClient) -> None:
    document = upload(client, make_pdf(page_count=1), "C:\\scans\\week 1\\answers.pdf").json()

    assert document["filename"] == "answers.pdf"


@pytest.mark.parametrize(
    "path",
    [
        "/api/documents/0123456789abcdef0123456789abcdef",
        "/api/documents/not-a-document-id",
        "/api/documents/..%2F..%2Fetc",
        "/api/documents/0123456789abcdef0123456789abcdef/pages/1/image",
    ],
)
def test_unknown_documents_are_not_found(client: TestClient, path: str) -> None:
    assert client.get(path).status_code == 404


def test_unknown_pages_are_not_found(client: TestClient) -> None:
    document = upload(client, make_pdf(page_count=1)).json()

    assert client.get(f"/api/documents/{document['id']}/pages/2/image").status_code == 404
    assert client.get(f"/api/documents/{document['id']}/pages/0/thumbnail").status_code == 404


def test_config_describes_prompts_and_limits(client: TestClient) -> None:
    config = client.get("/api/config").json()

    assert config["max_upload_mb"] == 1
    assert config["max_pages"] == 5
    assert ".pdf" in config["accepted_extensions"]
    assert [preset["id"] for preset in config["prompt_presets"]] == ["text", "markdown", "math"]
    assert config["default_prompt"] == config["prompt_presets"][0]["prompt"]


def test_frontend_build_is_served_when_present(settings: Settings, fake_ollama: FakeOllama) -> None:
    settings.frontend_dist.mkdir(parents=True)
    (settings.frontend_dist / "index.html").write_text("<h1>PaperEval</h1>")

    with make_client(settings, fake_ollama) as client:
        assert client.get("/").text == "<h1>PaperEval</h1>"
        assert client.get("/api/health").json() == {"status": "ok"}
