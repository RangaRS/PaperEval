"""Split an uploaded PDF or image into normalized page images."""

from __future__ import annotations

import io
import threading
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Literal

import pypdfium2 as pdfium
from PIL import Image, ImageOps, UnidentifiedImageError

SourceKind = Literal["pdf", "image"]
ImageFormat = Literal["PNG", "JPEG"]

# Longest side, in pixels, of a stored page image.
MAX_PAGE_SIDE = 4096

# PDFium is not thread-safe, so every PDFium call goes through this lock.
_PDFIUM_LOCK = threading.Lock()

# Formats whose frames are separate pages. Frames of animated GIF/WebP files and
# the embedded previews of MPO camera photos are not pages, so only the first
# frame of those is used.
_MULTI_PAGE_FORMATS = {"TIFF"}

# Photos are kept as JPEG to keep files small; everything else is stored as PNG.
_JPEG_FORMATS = {"JPEG", "MPO"}


class UnsupportedFileError(ValueError):
    """The upload is not a PDF or image that can be read."""


class TooManyPagesError(ValueError):
    """The upload has more pages than allowed."""


@dataclass
class RenderedPage:
    image: Image.Image
    format: ImageFormat


def detect_kind(data: bytes) -> SourceKind:
    """Tell whether ``data`` is a PDF or an image, raising UnsupportedFileError otherwise."""
    if b"%PDF-" in data[:1024]:
        return "pdf"
    try:
        with Image.open(io.BytesIO(data)):
            return "image"
    except Image.DecompressionBombError as exc:
        raise UnsupportedFileError("The image is too large to process.") from exc
    except (UnidentifiedImageError, OSError) as exc:
        raise UnsupportedFileError(
            "Unsupported file type. Upload a PDF or an image (PNG, JPEG, WebP, TIFF, ...)."
        ) from exc


def iter_pages(
    data: bytes,
    kind: SourceKind,
    *,
    dpi: int = 200,
    max_pages: int = 200,
    max_side: int = MAX_PAGE_SIDE,
) -> Iterator[RenderedPage]:
    """Yield one normalized RGB image per page: PDF pages, TIFF frames, or the image itself."""
    if kind == "pdf":
        return _iter_pdf_pages(data, dpi=dpi, max_pages=max_pages, max_side=max_side)
    return _iter_image_pages(data, max_pages=max_pages, max_side=max_side)


def normalize_image(image: Image.Image) -> Image.Image:
    """Return an upright RGB copy of ``image`` with any transparency flattened onto white."""
    image = ImageOps.exif_transpose(image)
    if image.mode.startswith(("I", "F")):
        # 16/32-bit images would clip to white when converted directly, so
        # stretch their actual value range onto 0-255 first.
        if image.mode.startswith("I;16"):
            image = image.convert("I")
        low, high = image.getextrema()
        scale = 255 / (high - low) if high > low else 1
        image = image.point(lambda value: (value - low) * scale).convert("L")
    if image.mode in ("RGBA", "LA", "PA", "RGBa", "La") or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        flattened = Image.new("RGB", rgba.size, "white")
        flattened.paste(rgba, mask=rgba.getchannel("A"))
        return flattened
    return image.convert("RGB")


def _limit_size(image: Image.Image, max_side: int) -> Image.Image:
    if max_side > 0 and max(image.size) > max_side:
        image.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    return image


def _check_page_count(count: int, max_pages: int) -> None:
    if count > max_pages:
        raise TooManyPagesError(f"The file has {count} pages; the limit is {max_pages}.")


def _iter_pdf_pages(data: bytes, *, dpi: int, max_pages: int, max_side: int) -> Iterator[RenderedPage]:
    with _PDFIUM_LOCK:
        try:
            pdf = pdfium.PdfDocument(data)
        except pdfium.PdfiumError as exc:
            if "password" in str(exc).lower():
                raise UnsupportedFileError(
                    "The PDF is password-protected. Remove the password and upload it again."
                ) from exc
            raise UnsupportedFileError("The PDF could not be read. It may be damaged.") from exc
        try:
            count = len(pdf)
            if count == 0:
                raise UnsupportedFileError("The PDF has no pages.")
            _check_page_count(count, max_pages)
            # Render filled-in form fields along with the page content.
            pdf.init_forms()
            for index in range(count):
                page = pdf[index]
                try:
                    width, height = page.get_size()  # in points, with the page rotation applied
                    scale = dpi / 72
                    if max_side > 0:
                        scale = min(scale, max_side / max(width, height, 1))
                    bitmap = page.render(scale=scale)
                    try:
                        # convert() copies the pixels out of PDFium's buffer.
                        image = bitmap.to_pil().convert("RGB")
                    finally:
                        bitmap.close()
                finally:
                    page.close()
                yield RenderedPage(image=image, format="PNG")
        finally:
            pdf.close()


def _iter_image_pages(data: bytes, *, max_pages: int, max_side: int) -> Iterator[RenderedPage]:
    try:
        source = Image.open(io.BytesIO(data))
    except Image.DecompressionBombError as exc:
        raise UnsupportedFileError("The image is too large to process.") from exc
    except (UnidentifiedImageError, OSError) as exc:
        raise UnsupportedFileError("The image could not be read.") from exc

    with source:
        image_format = (source.format or "").upper()
        frame_count = getattr(source, "n_frames", 1) if image_format in _MULTI_PAGE_FORMATS else 1
        _check_page_count(frame_count, max_pages)
        save_format: ImageFormat = "JPEG" if image_format in _JPEG_FORMATS else "PNG"
        for index in range(frame_count):
            try:
                source.seek(index)
                page = normalize_image(source)
            except (OSError, ValueError, SyntaxError) as exc:
                raise UnsupportedFileError(f"Page {index + 1} of the image could not be read.") from exc
            yield RenderedPage(image=_limit_size(page, max_side), format=save_format)
