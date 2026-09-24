from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

from app.ollama import OllamaClient, OllamaError

from .helpers import API_KEY, FakeOllama

SCHEMA = {"type": "object", "properties": {"marks": {"type": "number"}}, "required": ["marks"]}


def ask(fake: FakeOllama, model: str = "qwen3.5:397b-cloud") -> Any:
    async def run() -> Any:
        client = OllamaClient("https://ollama.com", api_key=API_KEY, transport=httpx.MockTransport(fake.handler))
        try:
            return await client.chat_json(model=model, system="Be an examiner.", prompt="Mark this.", schema=SCHEMA)
        finally:
            await client.aclose()

    return asyncio.run(run())


def test_chat_json_sends_a_structured_request_and_parses_the_answer() -> None:
    fake = FakeOllama()
    fake.json_reply = lambda payload: {"marks": 1.5}

    assert ask(fake) == {"marks": 1.5}

    (payload,) = fake.json_payloads()
    assert payload["model"] == "qwen3.5:397b"
    assert payload["messages"] == [
        {"role": "system", "content": "Be an examiner."},
        {"role": "user", "content": "Mark this."},
    ]
    assert payload["format"] == SCHEMA
    assert payload["stream"] is True
    assert payload["think"] is False
    assert payload["options"] == {"temperature": 0}


def test_unescaped_latex_in_the_answer_survives() -> None:
    fake = FakeOllama()
    fake.json_reply = lambda payload: '{"feedback": "Uses $\\frac{1}{2}$ and $\\theta$", "marks": 2}'

    assert ask(fake)["feedback"] == r"Uses $\frac{1}{2}$ and $\theta$"


def test_an_answer_that_is_not_json_is_an_error() -> None:
    fake = FakeOllama()
    fake.json_reply = lambda payload: "Sorry, I cannot help with that."

    with pytest.raises(OllamaError, match="did not answer in the expected format"):
        ask(fake)


def test_an_answer_cut_off_by_the_token_limit_says_so() -> None:
    fake = FakeOllama()
    fake.json_reply = lambda payload: '{"marks": '
    fake.json_done_reason = "length"

    with pytest.raises(OllamaError, match="ran out of room"):
        ask(fake)


def test_http_errors_name_the_model() -> None:
    fake = FakeOllama()
    fake.chat_status = 404
    fake.chat_error = {"error": "model 'nope' not found"}

    with pytest.raises(OllamaError, match="Model 'nope' was not found") as error:
        ask(fake, model="nope")
    assert error.value.status_code == 404
