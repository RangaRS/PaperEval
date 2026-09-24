"""Async client for the Ollama REST API.

Works with a local Ollama server (including "-cloud" models once it is signed in
with `ollama signin`) and with Ollama Cloud's API at https://ollama.com, which
takes an API key as a bearer token.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx

from .config import is_ollama_cloud_url
from .llm_json import loads_llm_json

API_KEYS_URL = "https://ollama.com/settings/keys"

# How long to remember what a model supports, and how soon to ask again after a failed lookup.
_CAPABILITIES_TTL_SECONDS = 600
_CAPABILITIES_RETRY_SECONDS = 30
_SHOW_TIMEOUT_SECONDS = 10.0
_MAX_CONCURRENT_SHOW_REQUESTS = 8


class OllamaError(Exception):
    """A failed Ollama request, with a message that can be shown to users."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class ModelInfo:
    name: str
    size: int | None
    parameter_size: str | None
    family: str | None
    # Whether the model accepts images; None when the server does not say.
    vision: bool | None
    cloud: bool


class OllamaClient:
    def __init__(
        self,
        base_url: str,
        *,
        api_key: str = "",
        timeout: float = 600.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.is_cloud = is_ollama_cloud_url(self.base_url)
        self.timeout = timeout
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._http = httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
            timeout=httpx.Timeout(timeout, connect=10.0),
            transport=transport,
        )
        # Model name -> (expiry time, capabilities).
        self._capabilities: dict[str, tuple[float, frozenset[str] | None]] = {}
        self._show_limit = asyncio.Semaphore(_MAX_CONCURRENT_SHOW_REQUESTS)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def version(self) -> str | None:
        """The server version, or None when it does not report one."""
        try:
            response = await self._http.get("/api/version", timeout=10.0)
            version = response.json().get("version") if response.status_code == 200 else None
        except (httpx.HTTPError, ValueError, AttributeError):
            return None
        return version if isinstance(version, str) else None

    async def list_models(self) -> list[ModelInfo]:
        data = await self._request_json("GET", "/api/tags", timeout=30.0)
        entries = [entry for entry in data.get("models") or [] if isinstance(entry, dict) and _model_name(entry)]
        capabilities = await asyncio.gather(*(self.capabilities(_model_name(entry)) for entry in entries))
        models = [self._model_info(entry, caps) for entry, caps in zip(entries, capabilities, strict=True)]
        return sorted(models, key=lambda model: model.name.lower())

    def api_model_name(self, model: str) -> str:
        """The name to send to the server for ``model``.

        A local Ollama runs cloud models under names like ``gemma3:27b-cloud``,
        which is also how ollama.com shows them. Ollama Cloud's own API knows
        them without the ``-cloud`` suffix, so drop it when calling it directly.
        """
        model = model.strip()
        if self.is_cloud:
            for suffix in ("-cloud", ":cloud"):
                if model.endswith(suffix) and len(model) > len(suffix):
                    return model.removesuffix(suffix)
        return model

    async def capabilities(self, model: str) -> frozenset[str] | None:
        """What a model supports (e.g. "vision", "thinking"), or None if the server does not say."""
        model = self.api_model_name(model)
        cached = self._capabilities.get(model)
        if cached and time.monotonic() < cached[0]:
            return cached[1]
        async with self._show_limit:
            try:
                response = await self._http.post("/api/show", json={"model": model}, timeout=_SHOW_TIMEOUT_SECONDS)
            except httpx.HTTPError:
                self._capabilities[model] = (time.monotonic() + _CAPABILITIES_RETRY_SECONDS, None)
                return None
        capabilities = None
        if response.status_code == 200:
            with contextlib.suppress(ValueError):
                capabilities = _parse_capabilities(response.json())
        self._capabilities[model] = (time.monotonic() + _CAPABILITIES_TTL_SECONDS, capabilities)
        return capabilities

    async def chat_stream(
        self,
        *,
        model: str,
        prompt: str,
        image_base64: str,
        options: dict[str, Any] | None = None,
        think: bool | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Send one image with a prompt and yield the streamed response chunks."""
        model = self.api_model_name(model)
        payload: dict[str, Any] = {
            "model": model,
            "messages": [{"role": "user", "content": prompt, "images": [image_base64]}],
            "stream": True,
        }
        if options:
            payload["options"] = options
        if think is not None:
            payload["think"] = think
        try:
            async with self._http.stream("POST", "/api/chat", json=payload) as response:
                if response.status_code != 200:
                    await response.aread()
                    raise self._response_error(response, model=model)
                async for line in response.aiter_lines():
                    chunk = _parse_chunk(line)
                    if chunk is not None:
                        yield chunk
        except httpx.TimeoutException as exc:
            raise OllamaError(f"Ollama did not respond within {self.timeout:g} seconds.") from exc
        except httpx.HTTPError as exc:
            raise OllamaError(self._connection_error_message(exc)) from exc

    async def chat_json(
        self,
        *,
        model: str,
        system: str,
        prompt: str,
        schema: dict[str, Any],
        num_ctx: int = 0,
    ) -> Any:
        """Ask for an answer in JSON shaped like ``schema``, and return it parsed.

        The answer is streamed, even though only the whole of it is used: long
        answers then keep the connection busy instead of leaving it idle for
        minutes, which proxies and gateways may cut off.
        """
        options: dict[str, Any] = {"temperature": 0}
        if num_ctx > 0:
            options["num_ctx"] = num_ctx
        payload = {
            "model": self.api_model_name(model),
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            "stream": True,
            "format": schema,
            "think": False,
            "options": options,
        }
        parts: list[str] = []
        done_reason = None
        try:
            async with self._http.stream("POST", "/api/chat", json=payload) as response:
                if response.status_code != 200:
                    await response.aread()
                    raise self._response_error(response, model=model)
                async for line in response.aiter_lines():
                    chunk = _parse_chunk(line)
                    if chunk is None:
                        continue
                    message = chunk.get("message") if isinstance(chunk.get("message"), dict) else {}
                    if isinstance(message.get("content"), str):
                        parts.append(message["content"])
                    if chunk.get("done"):
                        done_reason = chunk.get("done_reason")
                        break
        except httpx.TimeoutException as exc:
            raise OllamaError(f"Ollama did not respond within {self.timeout:g} seconds.") from exc
        except httpx.HTTPError as exc:
            raise OllamaError(self._connection_error_message(exc)) from exc
        try:
            return loads_llm_json("".join(parts))
        except ValueError:
            if done_reason == "length":
                raise OllamaError(f"{model} ran out of room before finishing its answer.") from None
            raise OllamaError(
                f"{model} did not answer in the expected format. Try again or use another model."
            ) from None

    async def _request_json(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        try:
            response = await self._http.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise OllamaError(f"Timed out waiting for Ollama at {self.base_url}.") from exc
        except httpx.HTTPError as exc:
            raise OllamaError(self._connection_error_message(exc)) from exc
        if response.status_code != 200:
            raise self._response_error(response)
        try:
            data = response.json()
        except ValueError:
            raise OllamaError(f"{self.base_url} did not answer like an Ollama server.") from None
        return data if isinstance(data, dict) else {}

    def _model_info(self, entry: dict[str, Any], capabilities: frozenset[str] | None) -> ModelInfo:
        name = _model_name(entry)
        details = entry.get("details") if isinstance(entry.get("details"), dict) else {}
        cloud = self.is_cloud or bool(entry.get("remote_host")) or name.endswith(("-cloud", ":cloud"))
        size = entry.get("size")
        return ModelInfo(
            name=name,
            # The local size of a cloud model is just a stub, so leave it out.
            size=size if isinstance(size, int) and size > 0 and not cloud else None,
            parameter_size=details.get("parameter_size") or None,
            family=details.get("family") or None,
            vision=None if capabilities is None else "vision" in capabilities,
            cloud=cloud,
        )

    def _connection_error_message(self, exc: httpx.HTTPError) -> str:
        reason = str(exc) or type(exc).__name__
        if self.is_cloud:
            return f"Could not connect to Ollama Cloud at {self.base_url} ({reason})."
        return (
            f"Could not connect to Ollama at {self.base_url} ({reason}). Make sure Ollama is running, "
            "or set OLLAMA_BASE_URL and OLLAMA_API_KEY to use Ollama Cloud directly."
        )

    def _response_error(self, response: httpx.Response, *, model: str | None = None) -> OllamaError:
        status = response.status_code
        detail = _error_detail(response)
        if status in (401, 403):
            if self.is_cloud and self.api_key:
                hint = f"Check that OLLAMA_API_KEY is a valid key from {API_KEYS_URL}."
            elif self.is_cloud:
                hint = f"Set OLLAMA_API_KEY to an API key from {API_KEYS_URL}."
            else:
                hint = (
                    "The Ollama app on this computer is not signed in to ollama.com, so it cannot run cloud "
                    "models. Run `ollama signin`, or set OLLAMA_API_KEY in backend/.env to use Ollama Cloud "
                    "directly."
                )
                signin_url = _json_field(response, "signin_url")
                if signin_url:
                    hint += f" Sign-in link: {signin_url}"
            return OllamaError(f"Ollama refused the request (HTTP {status}: {detail}). {hint}", status_code=status)
        if status == 402:
            return OllamaError(
                f"Your Ollama plan does not include {model or 'this model'} (HTTP 402: {detail}). "
                "Choose another model, or add usage credits on ollama.com.",
                status_code=status,
            )
        if status == 404 and model:
            hint = (
                "Check the model's exact name on ollama.com."
                if self.is_cloud
                else f"Pull it with `ollama pull {model}`."
            )
            return OllamaError(f"Model '{model}' was not found (HTTP 404: {detail}). {hint}", status_code=status)
        if status == 429:
            return OllamaError(
                f"Ollama rate limit reached (HTTP 429: {detail}). Wait a moment and try again, "
                "or check your Ollama Cloud usage limits.",
                status_code=status,
            )
        return OllamaError(f"Ollama returned an error (HTTP {status}: {detail}).", status_code=status)


def _parse_chunk(line: str) -> dict[str, Any] | None:
    """One line of a streamed chat response, or None for a line without a chunk."""
    if not line.strip():
        return None
    try:
        chunk = json.loads(line)
    except json.JSONDecodeError:
        raise OllamaError("Ollama sent a response that could not be read.") from None
    if not isinstance(chunk, dict):
        return None
    if chunk.get("error"):
        raise OllamaError(f"Ollama error: {chunk['error']}")
    return chunk


def _model_name(entry: dict[str, Any]) -> str:
    name = entry.get("name") or entry.get("model") or ""
    return name if isinstance(name, str) else ""


def _parse_capabilities(data: Any) -> frozenset[str] | None:
    if not isinstance(data, dict):
        return None
    capabilities = data.get("capabilities")
    if isinstance(capabilities, list):
        return frozenset(str(capability) for capability in capabilities)
    # Servers from before capabilities were reported still describe a vision
    # model's image projector.
    if data.get("projector_info"):
        return frozenset({"completion", "vision"})
    return None


def _json_field(response: httpx.Response, field: str) -> str | None:
    try:
        data = response.json()
    except ValueError:
        return None
    value = data.get(field) if isinstance(data, dict) else None
    return value if isinstance(value, str) and value else None


def _error_detail(response: httpx.Response) -> str:
    message = _json_field(response, "error")
    if message:
        return message
    text = response.text.strip()
    return text[:300] if text else (response.reason_phrase or "no details")
