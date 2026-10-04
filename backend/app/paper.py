"""How a question paper is laid out, and how its totals follow from that.

A paper is a tree. Its leaves are the questions, which the AI marks one by one.
Its other nodes are groups, such as "Part B", "Question 11" or "11 (a) or
11 (b)", each with a rule saying which of its children count:

- ``all``: every child counts, as with sub-parts that must all be answered.
- ``any``: only ``count`` of the children count, as with "answer any five" or
  "either/or" (any 1 of 2). The children that count are the ones that give
  the most marks, so a student who answers more than needed gets the better
  ones. With ``min_each``, the children of each child group are pooled, and at
  least ``min_each`` must come from each, as in "answer any six, at least two
  from each part" or "answer five, choosing one from each module".

A group may also have a ``cap`` on the marks it can give.

The totals are worked out here with plain rules after the answers are marked;
the AI never decides which answers count. ``frontend/src/paper.ts`` works them
out the same way, so the two must be kept in step.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Annotated, Literal

from pydantic import BaseModel, Field

ROOT_ID = "root"


def new_group_id() -> str:
    return "g" + uuid.uuid4().hex[:11]


class QuestionRef(BaseModel):
    kind: Literal["question"] = "question"
    question_id: str = Field(max_length=40)


class Group(BaseModel):
    kind: Literal["group"] = "group"
    id: str = Field(default_factory=new_group_id, max_length=40)
    # The group's name as printed, e.g. "Part B" or "11".
    label: str = Field(default="", max_length=100)
    # Instructions ("Answer any five") or text shared by its questions.
    text: str = Field(default="", max_length=20_000)
    rule: Literal["all", "any"] = "all"
    # For "any": how many of the children count.
    count: int = Field(default=1, ge=1, le=500)
    # For "any": at least this many from each child group, pooling their children. 0 for no such rule.
    min_each: int = Field(default=0, ge=0, le=500)
    # The most marks the group can give, or 0 for no limit.
    cap: float = Field(default=0, ge=0, le=10_000)
    children: list[Node] = Field(default=[], max_length=500)


Node = Annotated[Group | QuestionRef, Field(discriminator="kind")]
Group.model_rebuild()


def flat_paper(question_ids: Iterable[str]) -> Group:
    """A paper where every question counts: how answer keys were before they had groups."""
    return Group(id=ROOT_ID, children=[QuestionRef(question_id=question_id) for question_id in question_ids])


def normalize(structure: Group | None, question_ids: list[str]) -> Group:
    """The paper with every question in it exactly once.

    References to questions that are not there, or that come up a second time,
    are dropped, and questions the tree leaves out are added at the end. Group
    ids are made unique, and the root keeps the id ``root``.
    """
    if structure is None:
        return flat_paper(question_ids)
    known = set(question_ids)
    placed: set[str] = set()
    group_ids: set[str] = set()

    def clean(group: Group, *, root: bool = False) -> Group:
        group_id = ROOT_ID if root else group.id
        if not root and (not group_id or group_id in group_ids or group_id == ROOT_ID):
            group_id = new_group_id()
        group_ids.add(group_id)
        children: list[Group | QuestionRef] = []
        for child in group.children:
            if isinstance(child, Group):
                children.append(clean(child))
            elif child.question_id in known and child.question_id not in placed:
                placed.add(child.question_id)
                children.append(child)
        return group.model_copy(update={"id": group_id, "children": children})

    root = clean(structure, root=True)
    missing = [QuestionRef(question_id=question_id) for question_id in question_ids if question_id not in placed]
    if missing:
        root = root.model_copy(update={"children": [*root.children, *missing]})
    return root


def question_order(structure: Group) -> list[str]:
    """The questions' ids in the order they appear on the paper."""
    order: list[str] = []

    def walk(group: Group) -> None:
        for child in group.children:
            if isinstance(child, Group):
                walk(child)
            else:
                order.append(child.question_id)

    walk(structure)
    return order


def shared_texts(structure: Group) -> dict[str, list[str]]:
    """For each question, the instructions and text of the groups it is in, outermost first."""
    texts: dict[str, list[str]] = {}

    def walk(group: Group, above: list[str]) -> None:
        inside = [*above, group.text.strip()] if group.text.strip() else above
        for child in group.children:
            if isinstance(child, Group):
                walk(child, inside)
            else:
                texts[child.question_id] = inside

    walk(structure, [])
    return texts


@dataclass
class Tally:
    marks: float
    # The questions whose marks count towards the total.
    counted: list[str]
    # Whether the student wrote anything for any of these questions.
    attempted: bool


def paper_maximum(structure: Group, max_marks: dict[str, float]) -> float:
    """The most marks the paper can give."""
    return tally(structure, lambda question_id: max_marks.get(question_id, 0)).marks


def tally(
    structure: Group | QuestionRef,
    marks: Callable[[str], float],
    attempted: Callable[[str], bool] = lambda question_id: True,
) -> Tally:
    """The marks a node gives, and which questions they come from, given each question's marks."""
    if isinstance(structure, QuestionRef):
        question_id = structure.question_id
        return Tally(marks(question_id), [question_id], attempted(question_id))
    group = structure
    if group.rule == "all":
        parts = [tally(child, marks, attempted) for child in group.children]
        chosen = parts
    else:
        # Each candidate with the part it belongs to (None for no part), in paper order.
        candidates: list[tuple[int | None, Group | QuestionRef]] = []
        for index, child in enumerate(group.children):
            if group.min_each > 0 and isinstance(child, Group):
                candidates.extend((index, grandchild) for grandchild in child.children)
            else:
                candidates.append((None, child))
        parts = [tally(candidate, marks, attempted) for _, candidate in candidates]
        # Best first; among equals, one the student attempted, then the earlier one.
        ranked = sorted(range(len(parts)), key=lambda i: (-parts[i].marks, not parts[i].attempted, i))
        picked: list[int] = []
        if group.min_each > 0:
            for part in sorted({part for part, _ in candidates if part is not None}):
                picked.extend([i for i in ranked if candidates[i][0] == part][: group.min_each])
        for i in ranked:
            if len(picked) >= group.count:
                break
            if i not in picked:
                picked.append(i)
        chosen = [parts[i] for i in sorted(picked)]
    total = sum(part.marks for part in chosen)
    if group.cap > 0:
        total = min(total, group.cap)
    return Tally(
        marks=total,
        counted=[question_id for part in chosen for question_id in part.counted],
        attempted=any(part.attempted for part in parts),
    )


def rule_problems(structure: Group, max_marks: dict[str, float]) -> list[str]:
    """Things in the paper's rules that look like mistakes, in words for the teacher."""
    problems: list[str] = []

    def name(group: Group) -> str:
        return group.label or "A group"

    def walk(group: Group) -> None:
        if group.rule == "any":
            pool = (
                sum(len(child.children) if isinstance(child, Group) else 1 for child in group.children)
                if group.min_each > 0
                else len(group.children)
            )
            if group.count > pool:
                problems.append(f"{name(group)} counts {group.count}, but has only {pool} to choose from.")
            parts = sum(isinstance(child, Group) for child in group.children)
            if group.min_each > 0 and parts * group.min_each > group.count:
                problems.append(
                    f"{name(group)} needs at least {group.min_each} from each of {parts} parts, "
                    f"which is more than the {group.count} that count."
                )
            options = [
                tally(child, lambda question_id: max_marks.get(question_id, 0)).marks
                for child in group.children
                if group.min_each == 0
            ]
            if len(set(options)) > 1:
                problems.append(f"The choices in {name(group)} are not worth the same marks.")
        for child in group.children:
            if isinstance(child, Group):
                walk(child)

    walk(structure)
    return problems
