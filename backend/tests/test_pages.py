from __future__ import annotations

import io

import pypdfium2 as pdfium
import pytest
from PIL import Image

from app.pages import TooManyPagesError, UnsupportedFileError, detect_kind, iter_pages

from .helpers import make_image, make_pdf


def test_pdf_is_split_into_one_image_per_page() -> None:
    data = make_pdf(page_count=3, size=(612, 792))

    assert detect_kind(data) == "pdf"
    pages = list(iter_pages(data, "pdf", dpi=144))

    assert len(pages) == 3
    for page in pages:
        assert page.format == "PNG"
        assert page.image.mode == "RGB"
        assert page.image.size == (1224, 1584)  # 8.5 x 11 in at 144 dpi


def test_pdf_page_rotation_is_respected() -> None:
    pdf = pdfium.PdfDocument(make_pdf(page_count=1, size=(600, 800)))
    pdf[0].set_rotation(90)
    buffer = io.BytesIO()
    pdf.save(buffer)
    pdf.close()

    (page,) = iter_pages(buffer.getvalue(), "pdf", dpi=72)

    assert page.image.size == (800, 600)


def test_pdf_rendering_is_limited_to_max_side() -> None:
    (page,) = iter_pages(make_pdf(page_count=1, size=(612, 792)), "pdf", dpi=600, max_side=1000)

    assert max(page.image.size) == 1000


def test_pdf_with_too_many_pages_is_rejected() -> None:
    with pytest.raises(TooManyPagesError, match="3 pages; the limit is 2"):
        list(iter_pages(make_pdf(page_count=3), "pdf", max_pages=2))


def test_damaged_pdf_is_rejected() -> None:
    with pytest.raises(UnsupportedFileError, match="could not be read"):
        list(iter_pages(b"%PDF-1.7\nnot really a pdf", "pdf"))


def test_unknown_file_type_is_rejected() -> None:
    with pytest.raises(UnsupportedFileError, match="Unsupported file type"):
        detect_kind(b"just some text")


def test_multi_page_tiff_is_split_into_pages() -> None:
    frames = [Image.new("RGB", (200, 100), color) for color in ("red", "green", "blue")]
    buffer = io.BytesIO()
    frames[0].save(buffer, "TIFF", save_all=True, append_images=frames[1:])

    pages = list(iter_pages(buffer.getvalue(), detect_kind(buffer.getvalue())))

    assert [page.image.getpixel((0, 0)) for page in pages] == [(255, 0, 0), (0, 128, 0), (0, 0, 255)]
    assert all(page.format == "PNG" for page in pages)


def test_animated_gif_uses_only_the_first_frame() -> None:
    frames = [Image.new("RGB", (50, 50), color) for color in ("red", "blue")]
    buffer = io.BytesIO()
    frames[0].save(buffer, "GIF", save_all=True, append_images=frames[1:])

    pages = list(iter_pages(buffer.getvalue(), "image"))

    assert len(pages) == 1


def test_jpeg_exif_orientation_is_applied() -> None:
    exif = Image.Exif()
    exif[0x0112] = 6  # stored sideways; display rotated 90 degrees clockwise
    data = make_image("JPEG", size=(400, 300), exif=exif.tobytes())

    (page,) = iter_pages(data, detect_kind(data))

    assert page.image.size == (300, 400)
    assert page.format == "JPEG"


def test_transparency_is_flattened_onto_white() -> None:
    data = make_image("PNG", size=(10, 10), mode="RGBA")  # fully transparent black

    (page,) = iter_pages(data, "image")

    assert page.image.mode == "RGB"
    assert page.image.getpixel((5, 5)) == (255, 255, 255)


def test_16_bit_grayscale_keeps_its_contrast() -> None:
    image = Image.new("I;16", (256, 1))
    image.putdata([value * 256 for value in range(256)])
    buffer = io.BytesIO()
    image.save(buffer, "TIFF")

    (page,) = iter_pages(buffer.getvalue(), "image")

    assert page.image.getpixel((0, 0)) == (0, 0, 0)
    assert page.image.getpixel((128, 0))[0] in range(120, 136)
    assert page.image.getpixel((255, 0)) == (255, 255, 255)


def test_large_images_are_downscaled() -> None:
    (page,) = iter_pages(make_image("PNG", size=(5000, 100)), "image", max_side=4096)

    assert page.image.size == (4096, 82)
