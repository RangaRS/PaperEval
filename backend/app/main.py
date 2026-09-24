"""FastAPI application: the JSON API under /api and, once built, the React frontend."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .api import router
from .config import Settings
from .ollama import OllamaClient
from .storage import DocumentStore

logger = logging.getLogger("uvicorn.error")


def create_app(settings: Settings | None = None, *, ollama: OllamaClient | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    store = DocumentStore(settings.data_dir)
    ollama = ollama or OllamaClient(
        settings.ollama_base_url,
        api_key=settings.ollama_api_key,
        timeout=settings.ollama_timeout,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        store.remove_incomplete()
        where = "Ollama Cloud" if ollama.is_cloud else "Ollama"
        key = "with an API key" if ollama.api_key else "without an API key"
        logger.info("Using %s at %s (%s). Documents are stored in %s", where, ollama.base_url, key, store.root)
        try:
            yield
        finally:
            await ollama.aclose()

    app = FastAPI(title="PaperEval", summary="OCR for PDFs and images with Ollama vision models.", lifespan=lifespan)
    app.state.settings = settings
    app.state.store = store
    app.state.ollama = ollama
    app.include_router(router)

    # Serve the production build of the frontend, if there is one.
    if (settings.frontend_dist / "index.html").is_file():
        app.mount("/", StaticFiles(directory=settings.frontend_dist, html=True), name="frontend")
    return app


app = create_app()
