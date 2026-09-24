from __future__ import annotations

import base64
import io
from dataclasses import replace
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.main import create_app
from app.ocr import DEFAULT_PROMPT
from app.ollama import OllamaClient

from .helpers import API_KEY, FakeOllama, chat_chunk, make_client, make_pdf, read_events, upload


def run_ocr(client: TestClient, document: dict[str, Any], page: int = 1, **body: Any) -> list[dict[str, Any]]:
    response = client.post(f"/api/documents/{document['id']}/pages/{page}/ocr", json=body)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-ndjson")
    return read_events(response)


@pytest.fixture
def document(client: TestClient) -> dict[str, Any]:
    return upload(client, make_pdf(page_count=2)).json()


def test_status_lists_models_and_what_they_support(client: TestClient, fake_ollama: FakeOllama) -> None:
    status = client.get("/api/ollama").json()

    assert status["reachable"] is True
    assert status["cloud"] is True
    assert status["api_key_configured"] is True
    assert status["base_url"] == "https://ollama.com"
    assert status["version"] == "0.12.0"
    assert [(model["name"], model["vision"], model["cloud"]) for model in status["models"]] == [
        ("gpt-oss:120b", False, True),
        ("llava:7b", True, True),
        ("qwen3-vl:235b", True, True),
    ]
    # Every request to Ollama Cloud carries the API key.
    assert fake_ollama.requests
    assert all(request.headers["authorization"] == f"Bearer {API_KEY}" for request in fake_ollama.requests)


def test_status_when_the_server_does_not_report_capabilities(client: TestClient, fake_ollama: FakeOllama) -> None:
    fake_ollama.show_supported = False

    models = client.get("/api/ollama").json()["models"]

    assert {model["vision"] for model in models} == {None}


def test_status_when_ollama_is_unreachable(settings: Settings) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused", request=request)

    ollama = OllamaClient("http://localhost:11434", transport=httpx.MockTransport(refuse))
    with TestClient(create_app(settings, ollama=ollama)) as client:
        status = client.get("/api/ollama").json()

    assert status["reachable"] is False
    assert status["cloud"] is False
    assert status["api_key_configured"] is False
    assert "Could not connect to Ollama at http://localhost:11434" in status["error"]
    assert status["models"] == []


def test_model_capabilities_are_looked_up_once(client: TestClient, fake_ollama: FakeOllama) -> None:
    client.get("/api/ollama")
    client.get("/api/ollama")

    assert len(fake_ollama.requests_to("/api/show")) == len(fake_ollama.models)


def test_failed_capability_lookups_are_not_retried_on_every_refresh(settings: Settings) -> None:
    shows = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/show":
            shows.append(request)
            raise httpx.ReadTimeout("timed out", request=request)
        return httpx.Response(200, json={"models": [{"name": "qwen3-vl:235b"}]})

    ollama = OllamaClient("https://ollama.com", api_key=API_KEY, transport=httpx.MockTransport(handler))
    with TestClient(create_app(settings, ollama=ollama)) as client:
        first = client.get("/api/ollama").json()
        client.get("/api/ollama")

    assert first["reachable"] is True
    assert first["models"][0]["vision"] is None
    assert len(shows) == 1


def test_local_cloud_models_are_marked_as_cloud(settings: Settings, fake_ollama: FakeOllama) -> None:
    fake_ollama.models = {"qwen3-vl:235b-cloud": ["completion", "vision"], "llava:7b": ["completion", "vision"]}

    with make_client(settings, fake_ollama, base_url="http://localhost:11434", api_key="") as client:
        models = client.get("/api/ollama").json()["models"]

    assert [(model["name"], model["cloud"], model["size"]) for model in models] == [
        ("llava:7b", False, 4_000_000_000),
        ("qwen3-vl:235b-cloud", True, None),
    ]
    assert "authorization" not in fake_ollama.requests[0].headers


def test_ocr_streams_the_text_and_saves_it(
    client: TestClient, fake_ollama: FakeOllama, document: dict[str, Any]
) -> None:
    events = run_ocr(client, document, page=2, model="llava:7b")

    assert [event["type"] for event in events] == ["start", "chunk", "chunk", "done"]
    assert events[0]["model"] == "llava:7b"
    assert "".join(event["text"] for event in events if event["type"] == "chunk") == "Hello world"
    result = events[-1]["result"]
    assert result["text"] == "Hello world"
    assert result["model"] == "llava:7b"
    assert result["prompt"] == DEFAULT_PROMPT
    assert result["truncated"] is False
    assert (result["prompt_tokens"], result["output_tokens"]) == (812, 3)

    saved = client.get(f"/api/documents/{document['id']}").json()["pages"]
    assert saved[0]["ocr"] is None
    assert saved[1]["ocr"] == result


def test_ocr_sends_the_page_image_to_the_model(
    client: TestClient, fake_ollama: FakeOllama, document: dict[str, Any]
) -> None:
    run_ocr(client, document, model="llava:7b", prompt="Read this page.")

    payload = fake_ollama.chat_payload()
    assert payload["model"] == "llava:7b"
    assert payload["stream"] is True
    assert payload["options"] == {"temperature": 0}
    assert "think" not in payload
    (message,) = payload["messages"]
    assert message["role"] == "user"
    assert message["content"] == "Read this page."
    (image_base64,) = message["images"]
    image = Image.open(io.BytesIO(base64.b64decode(image_base64)))
    # The 850 x 1100 page is scaled down to OCR_MAX_IMAGE_SIDE (800).
    assert image.format == "PNG"
    assert image.size == (618, 800)


def test_ocr_turns_off_thinking_for_models_that_think(
    client: TestClient, fake_ollama: FakeOllama, document: dict[str, Any]
) -> None:
    run_ocr(client, document, model="qwen3-vl:235b")

    assert fake_ollama.chat_payload()["think"] is False


def test_thinking_is_reported_once_and_kept_out_of_the_text(
    client: TestClient, fake_ollama: FakeOllama, document: dict[str, Any]
) -> None:
    fake_ollama.chat_chunks = [
        chat_chunk("", thinking="Let me look"),
        chat_chunk("", thinking=" at the page."),
        chat_chunk("Invoice #42"),
        chat_chunk("", done=True, done_reason="stop"),
    ]

    events = run_ocr(client, document, model="llava:7b")

    assert [event["type"] for event in events] == ["start", "thinking", "chunk", "done"]
    assert events[-1]["result"]["text"] == "Invoice #42"


def test_ocr_uses_the_configured_default_model(settings: Settings, fake_ollama: FakeOllama) -> None:
    settings = replace(settings, ollama_model="llava:7b")
    with make_client(settings, fake_ollama) as client:
        document = upload(client, make_pdf(page_count=1)).json()
        events = run_ocr(client, document)

    assert events[-1]["type"] == "done"
    assert fake_ollama.chat_payload()["model"] == "llava:7b"


def test_ocr_needs_a_model(client: TestClient, document: dict[str, Any]) -> None:
    response = client.post(f"/api/documents/{document['id']}/pages/1/ocr")

    assert response.status_code == 400
    assert "No model selected" in response.json()["detail"]


def test_ocr_of_an_unknown_page_is_not_found(client: TestClient, document: dict[str, Any]) -> None:
    response = client.post(f"/api/documents/{document['id']}/pages/3/ocr", json={"model": "llava:7b"})

    assert response.status_code == 404


def test_models_that_cannot_read_images_are_refused(
    client: TestClient, fake_ollama: FakeOllama, document: dict[str, Any]
) -> None:
    events = run_ocr(client, document, model="gpt-oss:120b")

    assert [event["type"] for event in events] == ["start", "error"]
    assert "cannot read images" in events[-1]["message"]
    assert fake_ollama.requests_to("/api/chat") == []


def test_models_with_unknown_capabilities_are_tried(
    client: TestClient, fake_ollama: FakeOllama, document: dict[str, Any]
) -> None:
    fake_ollama.show_supported = False

    events = run_ocr(client, document, model="gpt-oss:120b")

    assert events[-1]["type"] == "done"


@pytest.mark.parametrize(
    ("status", "error", "expected"),
    [
        (401, "unauthorized", "Check that OLLAMA_API_KEY is a valid key from https://ollama.com/settings/keys"),
        (404, "model 'nope' not found", "Model 'nope' was not found"),
        (429, "too many requests", "rate limit reached"),
        (500, "failed to load model", "HTTP 500: failed to load model"),
    ],
)
def test_ocr_explains_ollama_cloud_errors(
    client: TestClient, fake_ollama: FakeOllama, document: dict[str, Any], status: int, error: str, expected: str
) -> None:
    fake_ollama.chat_status = status
    fake_ollama.chat_error = {"error": error}

    events = run_ocr(client, document, model="nope")

    assert events[-1]["type"] == "error"
    assert expected in events[-1]["message"]
    assert client.get(f"/api/documents/{document['id']}").json()["pages"][0]["ocr"] is None


@pytest.mark.parametrize(
    ("status", "body", "expected"),
    [
        (
            401,
            {"error": "unauthorized", "signin_url": "https://ollama.com/connect?key=abc"},
            "sign in with `ollama signin`",
        ),
        (404, {"error": "model 'llava:13b' not found"}, "Pull it with `ollama pull llava:13b`"),
    ],
)
def test_ocr_explains_local_ollama_errors(
    settings: Settings, fake_ollama: FakeOllama, status: int, body: dict[str, str], expected: str
) -> None:
    fake_ollama.chat_status = status
    fake_ollama.chat_error = body

    with make_client(settings, fake_ollama, base_url="http://localhost:11434", api_key="") as client:
        document = upload(client, make_pdf(page_count=1)).json()
        events = run_ocr(client, document, model="llava:13b")

    assert expected in events[-1]["message"]


def test_errors_in_the_middle_of_the_stream_are_reported_and_not_saved(
    client: TestClient, fake_ollama: FakeOllama, document: dict[str, Any]
) -> None:
    fake_ollama.chat_chunks = [chat_chunk("Partial"), {"error": "model runner crashed"}]

    events = run_ocr(client, document, model="llava:7b")

    assert [event["type"] for event in events] == ["start", "chunk", "error"]
    assert events[-1]["message"] == "Ollama error: model runner crashed"
    assert client.get(f"/api/documents/{document['id']}").json()["pages"][0]["ocr"] is None


def test_a_stream_that_ends_early_is_an_error(
    client: TestClient, fake_ollama: FakeOllama, document: dict[str, Any]
) -> None:
    fake_ollama.chat_chunks = [chat_chunk("Partial")]

    events = run_ocr(client, document, model="llava:7b")

    assert events[-1] == {"type": "error", "message": "Ollama ended the response before it was complete."}


def test_output_cut_off_by_the_token_limit_is_marked_truncated(
    client: TestClient, fake_ollama: FakeOllama, document: dict[str, Any]
) -> None:
    fake_ollama.chat_chunks = [chat_chunk("Very long"), chat_chunk("", done=True, done_reason="length")]

    events = run_ocr(client, document, model="llava:7b")

    assert events[-1]["result"]["truncated"] is True


def test_ocr_when_ollama_is_unreachable(settings: Settings) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused", request=request)

    ollama = OllamaClient("https://ollama.com", api_key=API_KEY, transport=httpx.MockTransport(refuse))
    with TestClient(create_app(settings, ollama=ollama)) as client:
        document = upload(client, make_pdf(page_count=1)).json()
        events = run_ocr(client, document, model="qwen3-vl:235b")

    assert events[-1]["type"] == "error"
    assert "Could not connect to Ollama Cloud at https://ollama.com" in events[-1]["message"]


def test_num_ctx_is_only_sent_when_configured(settings: Settings, fake_ollama: FakeOllama) -> None:
    settings = replace(settings, ollama_num_ctx=16384)
    with make_client(settings, fake_ollama) as client:
        document = upload(client, make_pdf(page_count=1)).json()
        run_ocr(client, document, model="llava:7b")

    assert fake_ollama.chat_payload()["options"] == {"temperature": 0, "num_ctx": 16384}
