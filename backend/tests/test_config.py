from __future__ import annotations

import pytest

from app.config import Settings


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("OLLAMA_BASE_URL", "OLLAMA_API_KEY", "OLLAMA_MODEL", "OLLAMA_NUM_CTX", "MAX_PAGES"):
        monkeypatch.delenv(name, raising=False)


def test_defaults_to_a_local_ollama() -> None:
    settings = Settings.from_env()

    assert settings.ollama_base_url == "http://localhost:11434"
    assert settings.uses_ollama_cloud is False


def test_an_api_key_defaults_to_ollama_cloud(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OLLAMA_API_KEY", "secret")

    settings = Settings.from_env()

    assert settings.ollama_base_url == "https://ollama.com"
    assert settings.uses_ollama_cloud is True
    assert "secret" not in repr(settings)


def test_an_explicit_base_url_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OLLAMA_API_KEY", "secret")
    monkeypatch.setenv("OLLAMA_BASE_URL", "gpu-box:11434/")

    assert Settings.from_env().ollama_base_url == "http://gpu-box:11434"


def test_a_trailing_api_path_is_dropped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OLLAMA_BASE_URL", "https://ollama.com/api/")

    assert Settings.from_env().ollama_base_url == "https://ollama.com"


def test_numbers_are_validated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAX_PAGES", "lots")

    with pytest.raises(ValueError, match="MAX_PAGES must be an integer"):
        Settings.from_env()
