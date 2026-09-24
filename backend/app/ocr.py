"""Extract the text of a page image with an Ollama vision model."""

from __future__ import annotations

import asyncio
import base64
import io
import time
from collections.abc import AsyncIterator
from contextlib import aclosing
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image

from .ollama import OllamaClient, OllamaError
from .storage import DocumentNotFoundError, DocumentStore, OcrResult, utc_now


@dataclass(frozen=True)
class PromptPreset:
    id: str
    label: str
    prompt: str


PROMPT_PRESETS = (
    PromptPreset(
        id="text",
        label="Plain text",
        prompt=(
            "Extract all of the text in this image exactly as it is written.\n"
            "- Keep the original reading order, line breaks and paragraph breaks.\n"
            "- Do not translate, summarize, correct or explain anything.\n"
            "- Do not add any commentary, labels or formatting of your own.\n"
            "Output only the extracted text. If the image contains no text, output nothing."
        ),
    ),
    PromptPreset(
        id="markdown",
        label="Markdown",
        prompt=(
            "Convert this document image to Markdown.\n"
            "- Transcribe all of the text exactly as it is written, in the original reading order.\n"
            "- Use Markdown headings, lists, emphasis and tables to mirror the document's structure.\n"
            "- Do not translate, summarize or add commentary.\n"
            "Output only the Markdown, without wrapping it in a code block."
        ),
    ),
    PromptPreset(
        id="math",
        label="Maths (LaTeX)",
        prompt=(
            "Transcribe all of the text in this image exactly as it is written, in the original reading order.\n"
            "- Write every mathematical expression in LaTeX: use $...$ for maths within a line and $$...$$ for "
            "maths on a line of its own.\n"
            "- Keep the original line breaks, numbering and question labels.\n"
            "- Do not solve, correct, simplify, summarize or explain anything, and do not add commentary.\n"
            "Output only the transcription."
        ),
    ),
)
DEFAULT_PROMPT = PROMPT_PRESETS[0].prompt


def encode_image(path: Path, max_side: int) -> str:
    """Base64-encode a page image for Ollama, downscaling it if it is larger than ``max_side``."""
    with Image.open(path) as image:
        if max_side <= 0 or max(image.size) <= max_side:
            return base64.b64encode(path.read_bytes()).decode("ascii")
        image_format = image.format if image.format in ("PNG", "JPEG") else "PNG"
        resized = image.convert("RGB")
    resized.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    if image_format == "JPEG":
        resized.save(buffer, "JPEG", quality=90)
    else:
        resized.save(buffer, "PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


async def ocr_events(
    *,
    ollama: OllamaClient,
    store: DocumentStore,
    document_id: str,
    page_number: int,
    image_path: Path,
    model: str,
    prompt: str,
    max_image_side: int,
    num_ctx: int = 0,
) -> AsyncIterator[dict[str, Any]]:
    """Run OCR on one page, yielding progress events for the client.

    Events: ``start``, then ``thinking`` (once, if the model reasons before
    answering), any number of ``chunk`` events with pieces of text, and finally
    either ``done`` with the saved result or ``error``.
    """
    started = time.monotonic()
    yield {"type": "start", "model": model}

    try:
        image_base64 = await asyncio.to_thread(encode_image, image_path, max_image_side)
    except OSError:
        yield {"type": "error", "message": "The page image could not be read. Was the document deleted?"}
        return

    # A model the server says cannot read images is still tried: it was chosen on
    # purpose, and that information is not always right for cloud models.
    capabilities = await ollama.capabilities(model)

    options: dict[str, Any] = {"temperature": 0}
    if num_ctx > 0:
        options["num_ctx"] = num_ctx
    # Reasoning would only slow down a transcription, so turn it off where possible.
    think = False if capabilities and "thinking" in capabilities else None

    parts: list[str] = []
    final_chunk: dict[str, Any] | None = None
    thinking = False
    stream = ollama.chat_stream(model=model, prompt=prompt, image_base64=image_base64, options=options, think=think)
    try:
        async with aclosing(stream):
            async for chunk in stream:
                message = chunk.get("message") if isinstance(chunk.get("message"), dict) else {}
                if message.get("thinking") and not thinking and not parts:
                    thinking = True
                    yield {"type": "thinking"}
                text = message.get("content")
                if isinstance(text, str) and text:
                    parts.append(text)
                    yield {"type": "chunk", "text": text}
                if chunk.get("done"):
                    final_chunk = chunk
                    break
    except OllamaError as exc:
        yield {"type": "error", "message": str(exc)}
        return

    if final_chunk is None:
        yield {"type": "error", "message": "Ollama ended the response before it was complete."}
        return

    result = OcrResult(
        text="".join(parts).strip(),
        model=model,
        prompt=prompt,
        created_at=utc_now(),
        duration_ms=round((time.monotonic() - started) * 1000),
        truncated=final_chunk.get("done_reason") == "length",
        prompt_tokens=_int_or_none(final_chunk.get("prompt_eval_count")),
        output_tokens=_int_or_none(final_chunk.get("eval_count")),
    )
    try:
        await asyncio.to_thread(store.save_ocr, document_id, page_number, result)
    except DocumentNotFoundError:
        yield {"type": "error", "message": "The document was deleted before the text could be saved."}
        return
    yield {"type": "done", "result": result.model_dump(mode="json")}


def _int_or_none(value: Any) -> int | None:
    return value if isinstance(value, int) else None
