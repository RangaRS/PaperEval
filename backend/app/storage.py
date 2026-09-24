"""Document storage on the local filesystem.

Each document lives in its own directory::

    <data_dir>/documents/<document id>/
        meta.json          document and page metadata, including OCR results
        page-0001.png      full-size page image (PNG, or JPEG for photos)
        thumb-0001.jpg     small preview for the page list
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import threading
import uuid
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from PIL import Image
from pydantic import BaseModel, ValidationError

from .pages import RenderedPage, SourceKind

logger = logging.getLogger(__name__)

META_FILE = "meta.json"
# What a document is to the evaluator (exam) it belongs to.
DocumentRole = Literal["key", "script"]
THUMBNAIL_SIZE = (240, 320)
ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
_STAGING_PREFIX = ".staging-"
_DELETING_PREFIX = ".deleting-"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class OcrResult(BaseModel):
    text: str
    model: str
    prompt: str
    created_at: datetime
    duration_ms: int
    # True when the model stopped because it hit its output token limit.
    truncated: bool = False
    prompt_tokens: int | None = None
    output_tokens: int | None = None


class StoredPage(BaseModel):
    number: int
    width: int
    height: int
    image_file: str
    thumbnail_file: str
    ocr: OcrResult | None = None


class StoredDocument(BaseModel):
    id: str
    filename: str
    kind: Literal["pdf", "image"]
    created_at: datetime
    pages: list[StoredPage]
    # The evaluator the document belongs to: its question paper and key, or a student's answer paper.
    exam_id: str | None = None
    role: DocumentRole | None = None

    def page(self, number: int) -> StoredPage | None:
        if 1 <= number <= len(self.pages):
            return self.pages[number - 1]
        return None


class DocumentNotFoundError(LookupError):
    pass


class DocumentStore:
    def __init__(self, data_dir: Path) -> None:
        self.root = data_dir / "documents"
        # Serializes read-modify-write cycles on meta.json files.
        self._lock = threading.Lock()

    def create(
        self,
        *,
        filename: str,
        kind: SourceKind,
        pages: Iterable[RenderedPage],
        exam_id: str | None = None,
        role: DocumentRole | None = None,
    ) -> StoredDocument:
        """Save the pages as a new document. Nothing is kept if any page fails."""
        document_id = uuid.uuid4().hex
        self.root.mkdir(parents=True, exist_ok=True)
        staging = self.root / f"{_STAGING_PREFIX}{document_id}"
        staging.mkdir()
        try:
            stored_pages = [self._write_page(staging, number, page) for number, page in enumerate(pages, start=1)]
            if not stored_pages:
                raise ValueError("A document needs at least one page.")
            document = StoredDocument(
                id=document_id,
                filename=filename,
                kind=kind,
                created_at=utc_now(),
                pages=stored_pages,
                exam_id=exam_id,
                role=role,
            )
            write_json_atomic(staging / META_FILE, document)
            staging.rename(self.root / document_id)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        return document

    def list_documents(self) -> list[StoredDocument]:
        """All documents, newest first."""
        if not self.root.is_dir():
            return []
        documents = []
        for path in self.root.iterdir():
            if not ID_PATTERN.match(path.name):
                continue
            try:
                documents.append(self._read(path))
            except (OSError, ValueError, ValidationError):
                logger.warning("Skipping unreadable document in %s", path, exc_info=True)
        documents.sort(key=lambda document: document.created_at, reverse=True)
        return documents

    def get(self, document_id: str) -> StoredDocument:
        try:
            return self._read(self._document_dir(document_id))
        except FileNotFoundError:
            raise DocumentNotFoundError(document_id) from None

    def delete(self, document_id: str) -> None:
        directory = self._document_dir(document_id)
        with self._lock:
            if not directory.is_dir():
                raise DocumentNotFoundError(document_id)
            # Rename first so the document disappears at once, even if removing the files takes a while.
            doomed = self.root / f"{_DELETING_PREFIX}{document_id}"
            directory.rename(doomed)
        shutil.rmtree(doomed, ignore_errors=True)

    def file_path(self, document_id: str, filename: str) -> Path:
        """Path of one of a document's files (page image or thumbnail)."""
        return self._document_dir(document_id) / Path(filename).name

    def assign(self, document_id: str, exam_id: str | None, role: DocumentRole | None) -> StoredDocument:
        """Make the document part of an evaluator, or of none."""
        directory = self._document_dir(document_id)
        with self._lock:
            try:
                document = self._read(directory)
            except FileNotFoundError:
                raise DocumentNotFoundError(document_id) from None
            document = document.model_copy(update={"exam_id": exam_id, "role": role if exam_id else None})
            write_json_atomic(directory / META_FILE, document)
        return document

    def save_ocr(self, document_id: str, page_number: int, result: OcrResult) -> StoredPage:
        directory = self._document_dir(document_id)
        with self._lock:
            try:
                document = self._read(directory)
            except FileNotFoundError:
                raise DocumentNotFoundError(document_id) from None
            page = document.page(page_number)
            if page is None:
                raise DocumentNotFoundError(f"{document_id} page {page_number}")
            page.ocr = result
            write_json_atomic(directory / META_FILE, document)
        return page

    def remove_incomplete(self) -> None:
        """Clean up uploads and deletions that were interrupted, e.g. by a crash."""
        if not self.root.is_dir():
            return
        for path in self.root.iterdir():
            if path.name.startswith((_STAGING_PREFIX, _DELETING_PREFIX)):
                shutil.rmtree(path, ignore_errors=True)

    def _document_dir(self, document_id: str) -> Path:
        if not ID_PATTERN.match(document_id):
            raise DocumentNotFoundError(document_id)
        return self.root / document_id

    @staticmethod
    def _read(directory: Path) -> StoredDocument:
        return StoredDocument.model_validate_json((directory / META_FILE).read_bytes())

    @staticmethod
    def _write_page(directory: Path, number: int, page: RenderedPage) -> StoredPage:
        extension = "jpg" if page.format == "JPEG" else "png"
        image_file = f"page-{number:04d}.{extension}"
        thumbnail_file = f"thumb-{number:04d}.jpg"
        if page.format == "JPEG":
            page.image.save(directory / image_file, "JPEG", quality=92)
        else:
            page.image.save(directory / image_file, "PNG")
        thumbnail = page.image.copy()
        thumbnail.thumbnail(THUMBNAIL_SIZE, Image.Resampling.LANCZOS)
        thumbnail.save(directory / thumbnail_file, "JPEG", quality=80)
        return StoredPage(
            number=number,
            width=page.image.width,
            height=page.image.height,
            image_file=image_file,
            thumbnail_file=thumbnail_file,
        )


def write_json_atomic(path: Path, model: BaseModel) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(model.model_dump_json(indent=2), encoding="utf-8")
    os.replace(temporary, path)
