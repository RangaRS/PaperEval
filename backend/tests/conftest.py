from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings

from .helpers import FakeOllama, make_client


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path / "data",
        frontend_dist=tmp_path / "no-frontend-build",
        pdf_dpi=100,
        max_upload_mb=1,
        max_pages=5,
        ocr_max_image_side=800,
    )


@pytest.fixture
def fake_ollama() -> FakeOllama:
    return FakeOllama()


@pytest.fixture
def client(settings: Settings, fake_ollama: FakeOllama) -> Iterator[TestClient]:
    with make_client(settings, fake_ollama) as test_client:
        yield test_client
