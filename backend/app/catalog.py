"""The college's structure: departments, their programmes, the subjects taught in each term, and exam sittings.

An evaluator (exam) can belong to one subject in one exam sitting: that subject's
paper in that sitting. Everything is stored together as ``<data_dir>/catalog.json``.
"""

from __future__ import annotations

import threading
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Literal, TypeVar

from pydantic import BaseModel, Field, field_validator

from .storage import write_json_atomic

TermType = Literal["semester", "year"]
SittingKind = Literal["internal", "model", "end_term", "supplementary", "other"]
Collection = Literal["departments", "programmes", "subjects", "sittings"]


def new_id() -> str:
    return uuid.uuid4().hex


class _Named(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    code: str = Field(default="", max_length=40)

    @field_validator("name", "code")
    @classmethod
    def _strip(cls, value: str) -> str:
        return value.strip()

    @field_validator("name")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value:
            raise ValueError("Give it a name.")
        return value


class Institution(BaseModel):
    name: str = Field(default="", max_length=200)


class DepartmentIn(_Named):
    pass


class Department(DepartmentIn):
    id: str


class ProgrammeIn(_Named):
    department_id: str
    # Whether the programme is taught in semesters or in years, and how many.
    term_type: TermType = "semester"
    term_count: int = Field(default=6, ge=1, le=12)


class Programme(ProgrammeIn):
    id: str


class SubjectIn(_Named):
    programme_id: str
    # The semester (or year) of the programme the subject is taught in, from 1.
    term: int = Field(ge=1, le=12)


class Subject(SubjectIn):
    id: str


class SittingIn(BaseModel):
    # e.g. "Nov/Dec 2026" or "Internal test 1".
    name: str = Field(min_length=1, max_length=200)
    kind: SittingKind = "end_term"
    # e.g. "2026-27".
    academic_year: str = Field(default="", max_length=20)

    @field_validator("name", "academic_year")
    @classmethod
    def _strip(cls, value: str) -> str:
        return value.strip()

    @field_validator("name")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value:
            raise ValueError("Give the exam sitting a name.")
        return value


class Sitting(SittingIn):
    id: str


class Catalog(BaseModel):
    institution: Institution = Institution()
    departments: list[Department] = []
    programmes: list[Programme] = []
    subjects: list[Subject] = []
    sittings: list[Sitting] = []

    @property
    def empty(self) -> bool:
        return not (self.departments or self.programmes or self.subjects or self.sittings)

    def department(self, department_id: str) -> Department | None:
        return next((item for item in self.departments if item.id == department_id), None)

    def programme(self, programme_id: str) -> Programme | None:
        return next((item for item in self.programmes if item.id == programme_id), None)

    def subject(self, subject_id: str) -> Subject | None:
        return next((item for item in self.subjects if item.id == subject_id), None)

    def sitting(self, sitting_id: str) -> Sitting | None:
        return next((item for item in self.sittings if item.id == sitting_id), None)


class CatalogItemNotFoundError(LookupError):
    pass


class CatalogConflictError(ValueError):
    """The change would leave the structure inconsistent, e.g. a subject in a programme that does not exist."""


Item = TypeVar("Item", Department, Programme, Subject, Sitting)


class CatalogStore:
    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "catalog.json"
        self._lock = threading.Lock()

    def get(self) -> Catalog:
        try:
            return Catalog.model_validate_json(self.path.read_bytes())
        except FileNotFoundError:
            return Catalog()

    def _change(self, change: Callable[[Catalog], None]) -> Catalog:
        with self._lock:
            catalog = self.get()
            change(catalog)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            write_json_atomic(self.path, catalog)
        return catalog

    def set_institution(self, institution: Institution) -> Catalog:
        def change(catalog: Catalog) -> None:
            catalog.institution = Institution(name=institution.name.strip())

        return self._change(change)

    def replace(self, catalog: Catalog) -> Catalog:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            write_json_atomic(self.path, catalog)
        return catalog

    def add(self, collection: Collection, body: BaseModel) -> Catalog:
        def change(catalog: Catalog) -> None:
            item = _ITEM_TYPES[collection](id=new_id(), **body.model_dump())
            _check(catalog, item)
            getattr(catalog, collection).append(item)

        return self._change(change)

    def update(self, collection: Collection, item_id: str, body: BaseModel) -> Catalog:
        def change(catalog: Catalog) -> None:
            items = getattr(catalog, collection)
            index = next((i for i, item in enumerate(items) if item.id == item_id), None)
            if index is None:
                raise CatalogItemNotFoundError(item_id)
            item = _ITEM_TYPES[collection](id=item_id, **body.model_dump())
            _check(catalog, item)
            items[index] = item

        return self._change(change)

    def delete(self, collection: Collection, item_id: str) -> Catalog:
        def change(catalog: Catalog) -> None:
            items = getattr(catalog, collection)
            if not any(item.id == item_id for item in items):
                raise CatalogItemNotFoundError(item_id)
            if collection == "departments" and any(p.department_id == item_id for p in catalog.programmes):
                raise CatalogConflictError("Delete or move this department's programmes first.")
            if collection == "programmes" and any(s.programme_id == item_id for s in catalog.subjects):
                raise CatalogConflictError("Delete this programme's subjects first.")
            setattr(catalog, collection, [item for item in items if item.id != item_id])

        return self._change(change)


_ITEM_TYPES: dict[str, type[BaseModel]] = {
    "departments": Department,
    "programmes": Programme,
    "subjects": Subject,
    "sittings": Sitting,
}


def _check(catalog: Catalog, item: BaseModel) -> None:
    """Make sure the item points at things that exist, and fits them."""
    if isinstance(item, Programme):
        if catalog.department(item.department_id) is None:
            raise CatalogConflictError("Choose a department that exists.")
        highest = max((s.term for s in catalog.subjects if s.programme_id == item.id), default=0)
        if highest > item.term_count:
            unit = "semesters" if item.term_type == "semester" else "years"
            raise CatalogConflictError(
                f"This programme has subjects in term {highest}, so it needs at least {highest} {unit}."
            )
    elif isinstance(item, Subject):
        programme = catalog.programme(item.programme_id)
        if programme is None:
            raise CatalogConflictError("Choose a programme that exists.")
        if item.term > programme.term_count:
            unit = "semesters" if programme.term_type == "semester" else "years"
            raise CatalogConflictError(f"{programme.name} has only {programme.term_count} {unit}.")


# ---------- A sample college, to show the structure in a demo ----------

_SAMPLE: list[tuple[str, str, list[tuple[str, str, int, dict[int, list[str]]]]]] = [
    (
        "Computer Science",
        "CS",
        [
            (
                "B.Sc Computer Science",
                "BSc CS",
                6,
                {
                    1: ["Programming in C", "Digital Fundamentals", "Mathematics for Computing"],
                    3: [
                        "Data Structures",
                        "Object Oriented Programming with Java",
                        "Discrete Mathematics",
                        "Computer Organisation",
                    ],
                    5: ["Operating Systems", "Database Management Systems", "Computer Networks", "Web Technology"],
                },
            ),
            (
                "M.Sc Computer Science",
                "MSc CS",
                4,
                {1: ["Advanced Algorithms", "Distributed Systems"], 3: ["Machine Learning", "Cloud Computing"]},
            ),
        ],
    ),
    (
        "Mathematics",
        "MA",
        [
            (
                "B.Sc Mathematics",
                "BSc Maths",
                6,
                {
                    1: ["Calculus", "Classical Algebra"],
                    3: ["Differential Equations", "Real Analysis I", "Mathematical Statistics"],
                    5: ["Complex Analysis", "Linear Algebra"],
                },
            ),
        ],
    ),
    (
        "Commerce",
        "CO",
        [
            (
                "B.Com",
                "BCom",
                6,
                {
                    1: ["Financial Accounting I", "Business Economics"],
                    3: ["Corporate Accounting", "Business Law"],
                    5: ["Cost Accounting", "Income Tax Law and Practice"],
                },
            ),
        ],
    ),
]


def sample_catalog() -> Catalog:
    """A made-up college with a few departments, programmes and odd-semester subjects, and three exam sittings."""
    catalog = Catalog(institution=Institution(name="Greenfield College of Arts and Science"))
    for department_name, prefix, programmes in _SAMPLE:
        department = Department(id=new_id(), name=department_name, code=prefix)
        catalog.departments.append(department)
        for level, (programme_name, programme_code, terms, subjects) in enumerate(programmes):
            programme = Programme(
                id=new_id(),
                department_id=department.id,
                name=programme_name,
                code=programme_code,
                term_type="semester",
                term_count=terms,
            )
            catalog.programmes.append(programme)
            for term, names in subjects.items():
                for index, name in enumerate(names, start=1):
                    # e.g. CS301 for the first third-semester subject, PCS301 for a postgraduate one.
                    code = f"{'P' if level else ''}{prefix}{term * 100 + index}"
                    catalog.subjects.append(
                        Subject(id=new_id(), programme_id=programme.id, term=term, code=code, name=name)
                    )
    catalog.sittings = [
        Sitting(id=new_id(), name="Apr/May 2026", kind="end_term", academic_year="2025-26"),
        Sitting(id=new_id(), name="Internal test 1", kind="internal", academic_year="2026-27"),
        Sitting(id=new_id(), name="Nov/Dec 2026", kind="end_term", academic_year="2026-27"),
    ]
    return catalog
