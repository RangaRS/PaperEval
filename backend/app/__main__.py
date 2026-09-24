"""Start the backend: ``python -m app``, from the backend folder.

It listens on BACKEND_HOST and BACKEND_PORT from backend/.env (127.0.0.1:8710
unless they are set), and restarts by itself when the code changes, for
example after a ``git pull``.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn

from .config import Settings

APP_DIR = Path(__file__).resolve().parent


def main(argv: list[str] | None = None) -> None:
    try:
        settings = Settings.from_env()
    except ValueError as exc:
        raise SystemExit(f"Please fix backend/.env: {exc}") from None
    parser = argparse.ArgumentParser(prog="python -m app", description="Start the PaperEval backend.")
    parser.add_argument(
        "--host", default=settings.host, help=f"address to listen on (default: {settings.host}, from BACKEND_HOST)"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=settings.port,
        help=f"port to listen on (default: {settings.port}, from BACKEND_PORT)",
    )
    parser.add_argument("--no-reload", dest="reload", action="store_false", help="don't restart when the code changes")
    args = parser.parse_args(argv)
    uvicorn.run(
        "app.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        # Only the code: not the uploaded documents and results in backend/data.
        reload_dirs=[str(APP_DIR)] if args.reload else None,
    )


if __name__ == "__main__":
    main()
