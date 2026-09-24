"""FastAPI application: the JSON API under /api and, once built, the React frontend."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import api, grading_api
from .config import Settings
from .evaluations import EvaluationStore, adopt_marked_papers
from .exams import ExamStore
from .ollama import OllamaClient
from .storage import DocumentStore

logger = logging.getLogger("uvicorn.error")


def create_app(settings: Settings | None = None, *, ollama: OllamaClient | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    store = DocumentStore(settings.data_dir)
    exam_store = ExamStore(settings.data_dir)
    evaluation_store = EvaluationStore(settings.data_dir)
    ollama = ollama or OllamaClient(
        settings.ollama_base_url,
        api_key=settings.ollama_api_key,
        timeout=settings.ollama_timeout,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        store.remove_incomplete()
        moved = adopt_marked_papers(store, exam_store, evaluation_store)
        if moved:
            logger.info("Moved %d marked answer papers into the evaluators they were marked against.", moved)
        where = "Ollama Cloud" if ollama.is_cloud else "Ollama"
        key = "with an API key" if ollama.api_key else "without an API key"
        logger.info("Using %s at %s (%s). Documents are stored in %s", where, ollama.base_url, key, store.root)
        try:
            yield
        finally:
            await ollama.aclose()

    app = FastAPI(
        title="PaperEval",
        summary="Extract the text of answer scripts with Ollama models, and mark them against an answer key.",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.store = store
    app.state.exam_store = exam_store
    app.state.evaluation_store = evaluation_store
    app.state.ollama = ollama
    app.include_router(api.router)
    app.include_router(grading_api.router)

    # Serve the production build of the frontend, if there is one.
    if (settings.frontend_dist / "index.html").is_file():
        app.mount("/", StaticFiles(directory=settings.frontend_dist, html=True), name="frontend")
    return app


app = create_app()
