from __future__ import annotations

from pathlib import Path

import pytest

from app.config import Settings


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("OLLAMA_BASE_URL", "OLLAMA_API_KEY", "OLLAMA_MODEL", "OLLAMA_NUM_CTX", "MAX_PAGES"):
        monkeypatch.delenv(name, raising=False)


def test_defaults_to_a_local_ollama() -> None:
    settings = Settings.from_env(env_file=None)

    assert settings.ollama_base_url == "http://localhost:11434"
    assert settings.uses_ollama_cloud is False


def test_an_api_key_defaults_to_ollama_cloud(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OLLAMA_API_KEY", "secret")

    settings = Settings.from_env(env_file=None)

    assert settings.ollama_base_url == "https://ollama.com"
    assert settings.uses_ollama_cloud is True
    assert "secret" not in repr(settings)


def test_an_explicit_base_url_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OLLAMA_API_KEY", "secret")
    monkeypatch.setenv("OLLAMA_BASE_URL", "gpu-box:11434/")

    assert Settings.from_env(env_file=None).ollama_base_url == "http://gpu-box:11434"


def test_a_trailing_api_path_is_dropped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OLLAMA_BASE_URL", "https://ollama.com/api/")

    assert Settings.from_env(env_file=None).ollama_base_url == "https://ollama.com"


def test_numbers_are_validated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAX_PAGES", "lots")

    with pytest.raises(ValueError, match="MAX_PAGES must be an integer"):
        Settings.from_env(env_file=None)


def test_settings_are_read_from_the_env_file(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("# Ollama Cloud\nOLLAMA_API_KEY=from-file\nOLLAMA_MODEL='gemma4:31b-cloud'\nMAX_PAGES=7\n")

    settings = Settings.from_env(env_file=env_file)

    assert settings.ollama_api_key == "from-file"
    assert settings.ollama_base_url == "https://ollama.com"
    assert settings.ollama_model == "gemma4:31b-cloud"
    assert settings.max_pages == 7


def test_environment_variables_win_over_the_env_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("MAX_PAGES=7\n")
    monkeypatch.setenv("MAX_PAGES", "9")

    assert Settings.from_env(env_file=env_file).max_pages == 9


def test_an_env_file_saved_with_a_byte_order_mark_is_read(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_bytes("OLLAMA_API_KEY=from-notepad\r\n".encode("utf-8-sig"))

    assert Settings.from_env(env_file=env_file).ollama_api_key == "from-notepad"


def test_a_missing_env_file_is_fine(tmp_path: Path) -> None:
    assert Settings.from_env(env_file=tmp_path / "missing.env").ollama_base_url == "http://localhost:11434"


def test_the_backend_listens_on_port_8710_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BACKEND_HOST", raising=False)
    monkeypatch.delenv("BACKEND_PORT", raising=False)

    settings = Settings.from_env(env_file=None)

    assert (settings.host, settings.port) == ("127.0.0.1", 8710)


def test_the_address_can_be_changed_in_the_env_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BACKEND_HOST", raising=False)
    monkeypatch.delenv("BACKEND_PORT", raising=False)
    env_file = tmp_path / ".env"
    env_file.write_text("BACKEND_HOST=0.0.0.0\nBACKEND_PORT=9123\n")

    settings = Settings.from_env(env_file=env_file)

    assert (settings.host, settings.port) == ("0.0.0.0", 9123)


@pytest.mark.parametrize("port", ["0", "70000", "http"])
def test_ports_are_validated(port: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BACKEND_PORT", port)

    with pytest.raises(ValueError, match="BACKEND_PORT must be"):
        Settings.from_env(env_file=None)
