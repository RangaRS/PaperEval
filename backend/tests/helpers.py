from __future__ import annotations

import io
import json
from collections.abc import Callable
from typing import Any

import httpx
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app.config import Settings
from app.main import create_app
from app.ollama import OllamaClient
from app.storage import OcrResult, utc_now

CLOUD_URL = "https://ollama.com"
API_KEY = "test-api-key"


class FakeOllama:
    """Scriptable stand-in for the Ollama HTTP API, plugged in through httpx.MockTransport."""

    def __init__(self) -> None:
        self.models: dict[str, list[str]] = {
            "gpt-oss:120b": ["completion", "tools", "thinking"],
            "qwen3-vl:235b": ["completion", "vision", "thinking"],
            "llava:7b": ["completion", "vision"],
        }
        self.show_supported = True
        self.chat_status = 200
        self.chat_error: dict[str, Any] = {"error": "something went wrong"}
        self.chat_chunks: list[dict[str, Any]] = [
            chat_chunk("Hello "),
            chat_chunk("world"),
            chat_chunk("", done=True, done_reason="stop", prompt_eval_count=812, eval_count=3),
        ]
        self.requests: list[httpx.Request] = []
        # Answers to requests for JSON (those with a system prompt): a function of
        # the request payload returning the reply's content (an object to encode,
        # or raw text), or a whole response to send instead, such as an error.
        self.json_reply: Callable[[dict[str, Any]], Any] = lambda payload: {}
        self.json_done_reason = "stop"

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/api/tags":
            models = [
                {
                    "name": name,
                    "model": name,
                    "size": 4_000_000_000,
                    "details": {"family": "qwen", "parameter_size": "7B"},
                }
                for name in self.models
            ]
            return httpx.Response(200, json={"models": models})
        if path == "/api/show":
            name = json.loads(request.content)["model"]
            if not self.show_supported or name not in self.models:
                return httpx.Response(404, json={"error": f"model '{name}' not found"})
            return httpx.Response(200, json={"capabilities": self.models[name]})
        if path == "/api/version":
            return httpx.Response(200, json={"version": "0.12.0"})
        if path == "/api/chat":
            if self.chat_status != 200:
                return httpx.Response(self.chat_status, json=self.chat_error)
            payload = json.loads(request.content)
            chunks = self.chat_chunks
            if _asks_for_json(payload):
                reply = self.json_reply(payload)
                if isinstance(reply, httpx.Response):
                    return reply
                content = reply if isinstance(reply, str) else json.dumps(reply)
                # Stream the answer in small pieces, like Ollama does.
                chunks = [chat_chunk(content[start : start + 10]) for start in range(0, len(content), 10)]
                chunks.append(chat_chunk("", done=True, done_reason=self.json_done_reason))
            body = "".join(json.dumps(chunk) + "\n" for chunk in chunks)
            return httpx.Response(200, content=body.encode(), headers={"Content-Type": "application/x-ndjson"})
        return httpx.Response(404, text="404 page not found")

    def requests_to(self, path: str) -> list[httpx.Request]:
        return [request for request in self.requests if request.url.path == path]

    def chat_payload(self) -> dict[str, Any]:
        (request,) = self.requests_to("/api/chat")
        return json.loads(request.content)

    def json_payloads(self) -> list[dict[str, Any]]:
        """Payloads of the chat requests for JSON answers, in order."""
        payloads = [json.loads(request.content) for request in self.requests_to("/api/chat")]
        return [payload for payload in payloads if _asks_for_json(payload)]


def _asks_for_json(payload: dict[str, Any]) -> bool:
    # Page reading sends just an image and a prompt; the JSON requests come with a system prompt.
    return payload["messages"][0]["role"] == "system"


def chat_chunk(content: str, *, done: bool = False, thinking: str | None = None, **extra: Any) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if thinking is not None:
        message["thinking"] = thinking
    return {"model": "test", "created_at": "2026-01-01T00:00:00Z", "message": message, "done": done, **extra}


def make_client(
    settings: Settings,
    fake_ollama: FakeOllama,
    *,
    base_url: str = CLOUD_URL,
    api_key: str = API_KEY,
) -> TestClient:
    ollama = OllamaClient(base_url, api_key=api_key, transport=httpx.MockTransport(fake_ollama.handler))
    return TestClient(create_app(settings, ollama=ollama))


def make_pdf(page_count: int = 2, size: tuple[int, int] = (612, 792)) -> bytes:
    """A PDF whose pages are ``size`` points large, each saying "Page N"."""
    pages = []
    for number in range(1, page_count + 1):
        page = Image.new("RGB", size, "white")
        ImageDraw.Draw(page).text((40, 40), f"Page {number}", fill="black")
        pages.append(page)
    buffer = io.BytesIO()
    pages[0].save(buffer, "PDF", save_all=True, append_images=pages[1:], resolution=72)
    return buffer.getvalue()


def make_image(
    image_format: str = "PNG", size: tuple[int, int] = (400, 300), mode: str = "RGB", **save_options: Any
) -> bytes:
    color: Any = 0 if mode.startswith(("I", "F", "L", "1")) else "white"
    image = Image.new(mode, size, color)
    buffer = io.BytesIO()
    image.save(buffer, image_format, **save_options)
    return buffer.getvalue()


def upload(client: TestClient, data: bytes, filename: str = "scan.pdf") -> Any:
    return client.post("/api/documents", files={"file": (filename, data, "application/octet-stream")})


def read_events(response: Any) -> list[dict[str, Any]]:
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def give_text(client: TestClient, document_id: str, texts: list[str]) -> None:
    """Save text for a document's first pages, as if it had been extracted."""
    store = client.app.state.store  # type: ignore[attr-defined]
    for number, text in enumerate(texts, start=1):
        result = OcrResult(text=text, model="test", prompt="", created_at=utc_now(), duration_ms=1)
        store.save_ocr(document_id, number, result)
