"""JSON API under /api."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import closing
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from .config import Settings
from .ocr import DEFAULT_PROMPT, PROMPT_PRESETS, ocr_events
from .ollama import OllamaClient, OllamaError
from .pages import TooManyPagesError, UnsupportedFileError, detect_kind, iter_pages
from .storage import DocumentNotFoundError, DocumentStore, OcrResult, StoredDocument, StoredPage

ACCEPTED_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"]

router = APIRouter(prefix="/api")


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_store(request: Request) -> DocumentStore:
    return request.app.state.store


def get_ollama(request: Request) -> OllamaClient:
    return request.app.state.ollama


SettingsDep = Annotated[Settings, Depends(get_settings)]
StoreDep = Annotated[DocumentStore, Depends(get_store)]
OllamaDep = Annotated[OllamaClient, Depends(get_ollama)]


class PageOut(BaseModel):
    number: int
    width: int
    height: int
    image_url: str
    thumbnail_url: str
    ocr: OcrResult | None


class DocumentOut(BaseModel):
    id: str
    filename: str
    kind: Literal["pdf", "image"]
    created_at: datetime
    pages: list[PageOut]


class ModelOut(BaseModel):
    name: str
    size: int | None
    parameter_size: str | None
    family: str | None
    vision: bool | None
    cloud: bool


class OllamaStatus(BaseModel):
    base_url: str
    cloud: bool
    api_key_configured: bool
    reachable: bool
    version: str | None = None
    error: str | None = None
    models: list[ModelOut] = []


class PromptPresetOut(BaseModel):
    id: str
    label: str
    prompt: str


class AppConfig(BaseModel):
    default_model: str
    default_prompt: str
    prompt_presets: list[PromptPresetOut]
    max_upload_mb: int
    max_pages: int
    accepted_extensions: list[str]


class OcrRequest(BaseModel):
    model: str = Field(default="", max_length=200)
    prompt: str = Field(default="", max_length=20_000)


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/config")
def get_config(settings: SettingsDep) -> AppConfig:
    return AppConfig(
        default_model=settings.ollama_model,
        default_prompt=DEFAULT_PROMPT,
        prompt_presets=[PromptPresetOut(id=p.id, label=p.label, prompt=p.prompt) for p in PROMPT_PRESETS],
        max_upload_mb=settings.max_upload_mb,
        max_pages=settings.max_pages,
        accepted_extensions=ACCEPTED_EXTENSIONS,
    )


@router.get("/ollama")
async def get_ollama_status(ollama: OllamaDep) -> OllamaStatus:
    """Whether Ollama can be reached, and which models it offers."""
    status = OllamaStatus(
        base_url=ollama.base_url,
        cloud=ollama.is_cloud,
        api_key_configured=bool(ollama.api_key),
        reachable=False,
    )
    try:
        models, version = await asyncio.gather(ollama.list_models(), ollama.version())
    except OllamaError as exc:
        status.error = str(exc)
        return status
    status.reachable = True
    status.version = version
    status.models = [
        ModelOut(
            name=model.name,
            size=model.size,
            parameter_size=model.parameter_size,
            family=model.family,
            vision=model.vision,
            cloud=model.cloud,
        )
        for model in models
    ]
    return status


@router.get("/documents")
def list_documents(store: StoreDep) -> list[DocumentOut]:
    return [_document_out(document) for document in store.list_documents()]


@router.post("/documents", status_code=201)
async def upload_document(file: UploadFile, settings: SettingsDep, store: StoreDep) -> DocumentOut:
    """Upload a PDF or image. It is split into one image per page."""
    data = await file.read(settings.max_upload_bytes + 1)
    if not data:
        raise HTTPException(400, "The uploaded file is empty.")
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(413, f"The file is larger than the {settings.max_upload_mb} MB limit.")
    filename = _clean_filename(file.filename)
    try:
        document = await run_in_threadpool(_ingest, data, filename, settings, store)
    except UnsupportedFileError as exc:
        raise HTTPException(415, str(exc)) from exc
    except TooManyPagesError as exc:
        raise HTTPException(422, str(exc)) from exc
    return _document_out(document)


@router.get("/documents/{document_id}")
def get_document(document_id: str, store: StoreDep) -> DocumentOut:
    return _document_out(_load_document(store, document_id))


@router.delete("/documents/{document_id}", status_code=204)
def delete_document(document_id: str, store: StoreDep) -> Response:
    try:
        store.delete(document_id)
    except DocumentNotFoundError:
        raise HTTPException(404, "Document not found.") from None
    return Response(status_code=204)


@router.get("/documents/{document_id}/pages/{page_number}/image")
def get_page_image(document_id: str, page_number: int, store: StoreDep) -> FileResponse:
    page = _load_page(_load_document(store, document_id), page_number)
    return _image_response(store.file_path(document_id, page.image_file))


@router.get("/documents/{document_id}/pages/{page_number}/thumbnail")
def get_page_thumbnail(document_id: str, page_number: int, store: StoreDep) -> FileResponse:
    page = _load_page(_load_document(store, document_id), page_number)
    return _image_response(store.file_path(document_id, page.thumbnail_file))


@router.post("/documents/{document_id}/pages/{page_number}/ocr")
async def extract_page_text(
    document_id: str,
    page_number: int,
    settings: SettingsDep,
    store: StoreDep,
    ollama: OllamaDep,
    body: OcrRequest | None = None,
) -> StreamingResponse:
    """Extract a page's text with an Ollama vision model.

    Responds with newline-delimited JSON events (see ``ocr_events``) so the text
    can be shown while the model is still writing it. The final result is saved
    with the page.
    """
    body = body or OcrRequest()
    page = _load_page(_load_document(store, document_id), page_number)
    model = body.model.strip() or settings.ollama_model
    if not model:
        raise HTTPException(400, "No model selected. Pass a model or set OLLAMA_MODEL.")
    events = ocr_events(
        ollama=ollama,
        store=store,
        document_id=document_id,
        page_number=page.number,
        image_path=store.file_path(document_id, page.image_file),
        model=model,
        prompt=body.prompt.strip() or DEFAULT_PROMPT,
        max_image_side=settings.ocr_max_image_side,
        num_ctx=settings.ollama_num_ctx,
    )
    return StreamingResponse(
        _ndjson(events),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _ingest(data: bytes, filename: str, settings: Settings, store: DocumentStore) -> StoredDocument:
    kind = detect_kind(data)
    with closing(iter_pages(data, kind, dpi=settings.pdf_dpi, max_pages=settings.max_pages)) as pages:
        return store.create(filename=filename, kind=kind, pages=pages)


async def _ndjson(events: AsyncIterator[dict[str, Any]]) -> AsyncIterator[str]:
    async for event in events:
        yield json.dumps(event, ensure_ascii=False) + "\n"


def _load_document(store: DocumentStore, document_id: str) -> StoredDocument:
    try:
        return store.get(document_id)
    except DocumentNotFoundError:
        raise HTTPException(404, "Document not found.") from None


def _load_page(document: StoredDocument, page_number: int) -> StoredPage:
    page = document.page(page_number)
    if page is None:
        raise HTTPException(404, "Page not found.")
    return page


def _image_response(path: Path) -> FileResponse:
    if not path.is_file():
        raise HTTPException(404, "Image not found.")
    media_type = "image/jpeg" if path.suffix == ".jpg" else "image/png"
    # A document's images never change, so browsers may cache them for good.
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "public, max-age=31536000, immutable"})


def _document_out(document: StoredDocument) -> DocumentOut:
    base = f"/api/documents/{document.id}/pages"
    return DocumentOut(
        id=document.id,
        filename=document.filename,
        kind=document.kind,
        created_at=document.created_at,
        pages=[
            PageOut(
                number=page.number,
                width=page.width,
                height=page.height,
                image_url=f"{base}/{page.number}/image",
                thumbnail_url=f"{base}/{page.number}/thumbnail",
                ocr=page.ocr,
            )
            for page in document.pages
        ],
    )


def _clean_filename(name: str | None) -> str:
    name = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(character for character in name if character.isprintable()).strip()
    return name[:200] or "upload"
