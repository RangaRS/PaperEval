"""JSON API for the college's structure, under /api/catalog."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .api import CatalogStoreDep, ExamStoreDep
from .catalog import (
    Catalog,
    CatalogConflictError,
    CatalogItemNotFoundError,
    Collection,
    DepartmentIn,
    Institution,
    ProgrammeIn,
    SittingIn,
    SubjectIn,
    sample_catalog,
)
from .exams import ExamStore

router = APIRouter(prefix="/api/catalog")

_NAMES = {"departments": "Department", "programmes": "Programme", "subjects": "Subject", "sittings": "Exam sitting"}


@router.get("")
def get_catalog(catalog: CatalogStoreDep) -> Catalog:
    return catalog.get()


@router.put("/institution")
def set_institution(body: Institution, catalog: CatalogStoreDep) -> Catalog:
    return catalog.set_institution(body)


@router.post("/sample")
def load_sample(catalog: CatalogStoreDep) -> Catalog:
    """Fill an empty structure with a made-up college, to try the app with."""
    if not catalog.get().empty:
        raise HTTPException(409, "The sample college can only be added while no departments or exam sittings exist.")
    return catalog.replace(sample_catalog())


def _add(catalog: CatalogStoreDep, collection: Collection, body: BaseModel) -> Catalog:
    try:
        return catalog.add(collection, body)
    except CatalogConflictError as exc:
        raise HTTPException(409, str(exc)) from None


def _update(catalog: CatalogStoreDep, collection: Collection, item_id: str, body: BaseModel) -> Catalog:
    try:
        return catalog.update(collection, item_id, body)
    except CatalogItemNotFoundError:
        raise HTTPException(404, f"{_NAMES[collection]} not found.") from None
    except CatalogConflictError as exc:
        raise HTTPException(409, str(exc)) from None


def _delete(catalog: CatalogStoreDep, exams: ExamStore, collection: Collection, item_id: str) -> Catalog:
    field = {"subjects": "subject_id", "sittings": "sitting_id"}.get(collection)
    if field and any(getattr(exam, field) == item_id for exam in exams.list_exams()):
        what = "subject" if collection == "subjects" else "exam sitting"
        raise HTTPException(409, f"This {what} has papers. Delete them, or move them elsewhere, first.")
    try:
        return catalog.delete(collection, item_id)
    except CatalogItemNotFoundError:
        raise HTTPException(404, f"{_NAMES[collection]} not found.") from None
    except CatalogConflictError as exc:
        raise HTTPException(409, str(exc)) from None


@router.post("/departments", status_code=201)
def add_department(body: DepartmentIn, catalog: CatalogStoreDep) -> Catalog:
    return _add(catalog, "departments", body)


@router.put("/departments/{item_id}")
def update_department(item_id: str, body: DepartmentIn, catalog: CatalogStoreDep) -> Catalog:
    return _update(catalog, "departments", item_id, body)


@router.delete("/departments/{item_id}")
def delete_department(item_id: str, catalog: CatalogStoreDep, exams: ExamStoreDep) -> Catalog:
    return _delete(catalog, exams, "departments", item_id)


@router.post("/programmes", status_code=201)
def add_programme(body: ProgrammeIn, catalog: CatalogStoreDep) -> Catalog:
    return _add(catalog, "programmes", body)


@router.put("/programmes/{item_id}")
def update_programme(item_id: str, body: ProgrammeIn, catalog: CatalogStoreDep) -> Catalog:
    return _update(catalog, "programmes", item_id, body)


@router.delete("/programmes/{item_id}")
def delete_programme(item_id: str, catalog: CatalogStoreDep, exams: ExamStoreDep) -> Catalog:
    return _delete(catalog, exams, "programmes", item_id)


@router.post("/subjects", status_code=201)
def add_subject(body: SubjectIn, catalog: CatalogStoreDep) -> Catalog:
    return _add(catalog, "subjects", body)


@router.put("/subjects/{item_id}")
def update_subject(item_id: str, body: SubjectIn, catalog: CatalogStoreDep) -> Catalog:
    return _update(catalog, "subjects", item_id, body)


@router.delete("/subjects/{item_id}")
def delete_subject(item_id: str, catalog: CatalogStoreDep, exams: ExamStoreDep) -> Catalog:
    return _delete(catalog, exams, "subjects", item_id)


@router.post("/sittings", status_code=201)
def add_sitting(body: SittingIn, catalog: CatalogStoreDep) -> Catalog:
    return _add(catalog, "sittings", body)


@router.put("/sittings/{item_id}")
def update_sitting(item_id: str, body: SittingIn, catalog: CatalogStoreDep) -> Catalog:
    return _update(catalog, "sittings", item_id, body)


@router.delete("/sittings/{item_id}")
def delete_sitting(item_id: str, catalog: CatalogStoreDep, exams: ExamStoreDep) -> Catalog:
    return _delete(catalog, exams, "sittings", item_id)
