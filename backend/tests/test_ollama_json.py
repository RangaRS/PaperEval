from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

from app.ollama import ChatText, OllamaClient, OllamaError, UnusableReplyError

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


def test_an_answer_that_is_not_json_is_an_error_that_keeps_the_answer() -> None:
    fake = FakeOllama()
    fake.json_reply = lambda payload: "Sorry, I cannot help with that."

    with pytest.raises(UnusableReplyError, match="did not answer in the expected format") as error:
        ask(fake)
    assert error.value.reply == "Sorry, I cannot help with that."


def test_an_empty_answer_says_so() -> None:
    fake = FakeOllama()
    fake.json_reply = lambda payload: ""

    with pytest.raises(UnusableReplyError, match="returned an empty answer"):
        ask(fake)


def test_the_answer_is_passed_on_as_it_arrives() -> None:
    fake = FakeOllama()
    fake.json_reply = lambda payload: {"feedback": "A long explanation of the marks.", "marks": 2}
    pieces: list[str] = []

    async def run() -> ChatText:
        client = OllamaClient("https://ollama.com", api_key=API_KEY, transport=httpx.MockTransport(fake.handler))
        try:
            return await client.chat_text(model="m", system="S", prompt="P", on_text=pieces.append)
        finally:
            await client.aclose()

    answer = asyncio.run(run())

    assert len(pieces) > 1
    assert "".join(pieces) == answer.text == '{"feedback": "A long explanation of the marks.", "marks": 2}'
    assert answer.done_reason == "stop"
    # Without a schema, no format is asked for.
    assert "format" not in fake.json_payloads()[0]


def test_an_answer_cut_off_by_the_token_limit_says_so() -> None:
    fake = FakeOllama()
    fake.json_reply = lambda payload: '{"marks": '
    fake.json_done_reason = "length"

    with pytest.raises(OllamaError, match="reached its output limit"):
        ask(fake)


def test_http_errors_name_the_model() -> None:
    fake = FakeOllama()
    fake.chat_status = 404
    fake.chat_error = {"error": "model 'nope' not found"}

    with pytest.raises(OllamaError, match="Model 'nope' was not found") as error:
        ask(fake, model="nope")
    assert error.value.status_code == 404


def test_a_model_outside_the_plan_says_so() -> None:
    fake = FakeOllama()
    fake.chat_status = 402
    fake.chat_error = {"error": "this model is not included in your free usage"}

    with pytest.raises(OllamaError, match=r"Your Ollama plan does not include gemma4:31b-cloud \(HTTP 402") as error:
        ask(fake, model="gemma4:31b-cloud")
    assert error.value.status_code == 402
