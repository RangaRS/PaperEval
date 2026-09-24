"""Application settings, read from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

BACKEND_DIR = Path(__file__).resolve().parent.parent

LOCAL_OLLAMA_URL = "http://localhost:11434"
OLLAMA_CLOUD_URL = "https://ollama.com"


def _env_str(name: str, default: str) -> str:
    value = os.environ.get(name, "").strip()
    return value or default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"Environment variable {name} must be an integer, got {raw!r}") from exc


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ValueError(f"Environment variable {name} must be a number, got {raw!r}") from exc


def _normalize_url(url: str) -> str:
    url = url.strip().rstrip("/")
    if "://" not in url:
        url = f"http://{url}"
    # The client adds /api/... itself, so accept URLs copied with it.
    return url.removesuffix("/api")


def is_ollama_cloud_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host == "ollama.com" or host.endswith(".ollama.com")


@dataclass(frozen=True)
class Settings:
    # Ollama server. Use https://ollama.com (with an API key) to call Ollama Cloud
    # directly, or a local Ollama server (which can also run "-cloud" models once
    # signed in with `ollama signin`).
    ollama_base_url: str = LOCAL_OLLAMA_URL
    ollama_api_key: str = field(default="", repr=False)
    # Model used when a request does not name one.
    ollama_model: str = ""
    # Seconds to wait for Ollama to send the next piece of a response.
    ollama_timeout: float = 600.0
    # Context window to request (local models only). 0 leaves it to the server.
    ollama_num_ctx: int = 0

    data_dir: Path = BACKEND_DIR / "data"
    frontend_dist: Path = BACKEND_DIR.parent / "frontend" / "dist"

    # Resolution used to render PDF pages.
    pdf_dpi: int = 200
    max_upload_mb: int = 50
    max_pages: int = 200
    # Page images are downscaled to at most this many pixels on their longest
    # side before being sent to the model. 0 sends them at full resolution.
    ocr_max_image_side: int = 2048

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def uses_ollama_cloud(self) -> bool:
        return is_ollama_cloud_url(self.ollama_base_url)

    @classmethod
    def from_env(cls) -> Settings:
        api_key = os.environ.get("OLLAMA_API_KEY", "").strip()
        # An API key is only needed to call Ollama Cloud directly, so default to it.
        default_url = OLLAMA_CLOUD_URL if api_key else LOCAL_OLLAMA_URL
        return cls(
            ollama_base_url=_normalize_url(_env_str("OLLAMA_BASE_URL", default_url)),
            ollama_api_key=api_key,
            ollama_model=_env_str("OLLAMA_MODEL", ""),
            ollama_timeout=_env_float("OLLAMA_TIMEOUT", cls.ollama_timeout),
            ollama_num_ctx=_env_int("OLLAMA_NUM_CTX", cls.ollama_num_ctx),
            data_dir=Path(_env_str("DATA_DIR", str(cls.data_dir))).expanduser(),
            frontend_dist=Path(_env_str("FRONTEND_DIST", str(cls.frontend_dist))).expanduser(),
            pdf_dpi=_env_int("PDF_DPI", cls.pdf_dpi),
            max_upload_mb=_env_int("MAX_UPLOAD_MB", cls.max_upload_mb),
            max_pages=_env_int("MAX_PAGES", cls.max_pages),
            ocr_max_image_side=_env_int("OCR_MAX_IMAGE_SIDE", cls.ocr_max_image_side),
        )
