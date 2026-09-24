from __future__ import annotations

from typing import Any

import pytest

from app import __main__ as entry
from app.config import Settings


@pytest.fixture
def started(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """The arguments uvicorn.run is called with, instead of starting a server."""
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(entry.uvicorn, "run", lambda app, **options: calls.append({"app": app, **options}))
    monkeypatch.setattr(Settings, "from_env", classmethod(lambda cls, env_file=None: Settings(port=9123)))
    return calls


def test_starts_on_the_configured_port_and_reloads_on_code_changes(started: list[dict[str, Any]]) -> None:
    entry.main([])

    (options,) = started
    assert options["app"] == "app.main:app"
    assert (options["host"], options["port"]) == ("127.0.0.1", 9123)
    assert options["reload"] is True
    assert options["reload_dirs"] == [str(entry.APP_DIR)]


def test_the_command_line_wins(started: list[dict[str, Any]]) -> None:
    entry.main(["--host", "0.0.0.0", "--port", "9200", "--no-reload"])

    (options,) = started
    assert (options["host"], options["port"], options["reload"]) == ("0.0.0.0", 9200, False)
    assert options["reload_dirs"] is None


def test_a_broken_env_file_is_explained(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(cls: type[Settings], env_file: object = None) -> Settings:
        raise ValueError("Environment variable BACKEND_PORT must be an integer, got 'x'")

    monkeypatch.setattr(Settings, "from_env", classmethod(broken))

    with pytest.raises(SystemExit, match=r"Please fix backend/\.env: .*BACKEND_PORT"):
        entry.main([])
