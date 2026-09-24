"""JSON API under /api."""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import AsyncIterator
from contextlib import closing
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Form, HTTPException, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from .config import Settings
from .evaluations import EvaluationStore
from .exams import ExamNotFoundError, ExamStore
from .ocr import DEFAULT_PROMPT, PROMPT_PRESETS, ocr_events
from .ollama import OllamaClient, OllamaError
from .pages import TooManyPagesError, UnsupportedFileError, detect_kind, iter_pages
from .storage import DocumentNotFoundError, DocumentRole, DocumentStore, OcrResult, StoredDocument, StoredPage

ACCEPTED_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"]

router = APIRouter(prefix="/api")


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_store(request: Request) -> DocumentStore:
    return request.app.state.store


def get_ollama(request: Request) -> OllamaClient:
    return request.app.state.ollama


def get_exam_store(request: Request) -> ExamStore:
    return request.app.state.exam_store


def get_evaluation_store(request: Request) -> EvaluationStore:
    return request.app.state.evaluation_store


SettingsDep = Annotated[Settings, Depends(get_settings)]
StoreDep = Annotated[DocumentStore, Depends(get_store)]
OllamaDep = Annotated[OllamaClient, Depends(get_ollama)]
ExamStoreDep = Annotated[ExamStore, Depends(get_exam_store)]
EvaluationStoreDep = Annotated[EvaluationStore, Depends(get_evaluation_store)]


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
    # The evaluator the document belongs to, and whether it is its key file or a student's answer paper.
    exam_id: str | None
    role: DocumentRole | None


class DocumentAssignment(BaseModel):
    """Where a document belongs: an evaluator and its role there, or nowhere (both null)."""

    exam_id: str | None = None
    role: DocumentRole | None = None


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
async def upload_document(
    file: UploadFile,
    settings: SettingsDep,
    store: StoreDep,
    exams: ExamStoreDep,
    exam_id: Annotated[str | None, Form()] = None,
    role: Annotated[DocumentRole | None, Form()] = None,
) -> DocumentOut:
    """Upload a PDF or image. It is split into one image per page.

    With ``exam_id`` and ``role``, the document belongs to that evaluator: as
    its question paper and key (``key``, replacing any earlier one), or as a
    student's answer paper (``script``).
    """
    _check_assignment(exams, DocumentAssignment(exam_id=exam_id, role=role))
    data = await file.read(settings.max_upload_bytes + 1)
    if not data:
        raise HTTPException(400, "The uploaded file is empty.")
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(413, f"The file is larger than the {settings.max_upload_mb} MB limit.")
    filename = _clean_filename(file.filename)
    try:
        document = await run_in_threadpool(_ingest, data, filename, settings, store, exam_id, role)
    except UnsupportedFileError as exc:
        raise HTTPException(415, str(exc)) from exc
    except TooManyPagesError as exc:
        raise HTTPException(422, str(exc)) from exc
    if exam_id and role == "key":
        _make_key(store, exams, exam_id, document.id)
    return _document_out(document)


@router.patch("/documents/{document_id}")
def assign_document(document_id: str, body: DocumentAssignment, store: StoreDep, exams: ExamStoreDep) -> DocumentOut:
    """Make an uploaded document part of an evaluator, or take it out of one."""
    _check_assignment(exams, body)
    before = load_document(store, document_id)
    document = store.assign(document_id, body.exam_id, body.role)
    if before.role == "key" and before.exam_id and (before.exam_id, "key") != (body.exam_id, body.role):
        _drop_key(exams, before.exam_id, document_id)
    if body.exam_id and body.role == "key":
        _make_key(store, exams, body.exam_id, document_id)
    return _document_out(document)


@router.get("/documents/{document_id}")
def get_document(document_id: str, store: StoreDep) -> DocumentOut:
    return _document_out(load_document(store, document_id))


@router.delete("/documents/{document_id}", status_code=204)
def delete_document(
    document_id: str, store: StoreDep, exams: ExamStoreDep, evaluations: EvaluationStoreDep
) -> Response:
    """Delete a document, with its extracted text and evaluations."""
    document = load_document(store, document_id)
    try:
        store.delete(document_id)
    except DocumentNotFoundError:
        raise HTTPException(404, "Document not found.") from None
    evaluations.delete_where(document_id=document_id)
    if document.role == "key" and document.exam_id:
        _drop_key(exams, document.exam_id, document_id)
    return Response(status_code=204)


@router.get("/documents/{document_id}/pages/{page_number}/image")
def get_page_image(document_id: str, page_number: int, store: StoreDep) -> FileResponse:
    page = _load_page(load_document(store, document_id), page_number)
    return _image_response(store.file_path(document_id, page.image_file))


@router.get("/documents/{document_id}/pages/{page_number}/thumbnail")
def get_page_thumbnail(document_id: str, page_number: int, store: StoreDep) -> FileResponse:
    page = _load_page(load_document(store, document_id), page_number)
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
    page = _load_page(load_document(store, document_id), page_number)
    model = choose_model(body.model, settings)
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
    return ndjson_response(events)


def choose_model(requested: str, settings: Settings) -> str:
    """The model a request asks for, or else the configured default."""
    model = requested.strip() or settings.ollama_model
    if not model:
        raise HTTPException(400, "No model selected. Pass a model or set OLLAMA_MODEL.")
    return model


def ndjson_response(events: AsyncIterator[dict[str, Any]]) -> StreamingResponse:
    """Stream events as newline-delimited JSON, one event per line, as soon as each is ready."""
    return StreamingResponse(
        _ndjson(events),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def load_document(store: DocumentStore, document_id: str) -> StoredDocument:
    try:
        return store.get(document_id)
    except DocumentNotFoundError:
        raise HTTPException(404, "Document not found.") from None


def _ingest(
    data: bytes,
    filename: str,
    settings: Settings,
    store: DocumentStore,
    exam_id: str | None = None,
    role: DocumentRole | None = None,
) -> StoredDocument:
    kind = detect_kind(data)
    with closing(iter_pages(data, kind, dpi=settings.pdf_dpi, max_pages=settings.max_pages)) as pages:
        return store.create(filename=filename, kind=kind, pages=pages, exam_id=exam_id, role=role)


def _check_assignment(exams: ExamStore, assignment: DocumentAssignment) -> None:
    if (assignment.exam_id is None) != (assignment.role is None):
        raise HTTPException(422, "Give both the evaluator and the document's role in it, or neither.")
    if assignment.exam_id is not None:
        try:
            exams.get(assignment.exam_id)
        except ExamNotFoundError:
            raise HTTPException(404, "Evaluator not found.") from None


def _make_key(store: DocumentStore, exams: ExamStore, exam_id: str, document_id: str) -> None:
    """Make the document the evaluator's key file. An earlier key file is kept, but no longer belongs to it."""
    earlier = exams.get(exam_id).key_document_id
    exams.set_key_document(exam_id, document_id)
    if earlier and earlier != document_id:
        with contextlib.suppress(DocumentNotFoundError):
            store.assign(earlier, None, None)


def _drop_key(exams: ExamStore, exam_id: str, document_id: str) -> None:
    """The document is no longer the evaluator's key file."""
    with contextlib.suppress(ExamNotFoundError):
        if exams.get(exam_id).key_document_id == document_id:
            exams.set_key_document(exam_id, None)


async def _ndjson(events: AsyncIterator[dict[str, Any]]) -> AsyncIterator[str]:
    async for event in events:
        yield json.dumps(event, ensure_ascii=False) + "\n"


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
        exam_id=document.exam_id,
        role=document.role,
    )


def _clean_filename(name: str | None) -> str:
    name = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(character for character in name if character.isprintable()).strip()
    return name[:200] or "upload"
