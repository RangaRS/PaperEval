from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.grading import parse_answer_key
from app.paper import Group, QuestionRef, normalize, paper_maximum, question_order, rule_problems, tally

from .helpers import FakeOllama, give_text, make_pdf, upload
from .test_evaluations_api import evaluate


def q(question_id: str) -> QuestionRef:
    return QuestionRef(question_id=question_id)


def either(*ids: str, label: str = "") -> Group:
    return Group(label=label, rule="any", count=1, children=[q(question_id) for question_id in ids])


def score(structure: Group, marks: dict[str, float], attempted: set[str] | None = None) -> tuple[float, list[str]]:
    result = tally(
        structure,
        lambda question_id: marks.get(question_id, 0),
        (lambda question_id: question_id in attempted) if attempted is not None else (lambda question_id: True),
    )
    return result.marks, result.counted


def test_every_question_counts_in_a_paper_without_groups() -> None:
    paper = normalize(None, ["a", "b"])

    assert paper.rule == "all"
    assert paper_maximum(paper, {"a": 2, "b": 3}) == 5
    assert score(paper, {"a": 1, "b": 2}) == (3, ["a", "b"])


def test_either_or_counts_the_better_answer_once() -> None:
    paper = Group(children=[q("1"), either("11a", "11b")])

    assert paper_maximum(paper, {"1": 2, "11a": 13, "11b": 13}) == 15
    assert score(paper, {"1": 2, "11a": 6, "11b": 9}) == (11, ["1", "11b"])
    assert score(paper, {"1": 2, "11a": 6}) == (8, ["1", "11a"])


def test_ties_go_to_the_answer_the_student_wrote() -> None:
    paper = either("11a", "11b")

    assert score(paper, {}, attempted={"11b"}) == (0, ["11b"])
    assert score(paper, {}, attempted=set()) == (0, ["11a"])


def test_an_option_with_sub_parts_counts_as_a_whole() -> None:
    option_a = Group(label="11 (a)", children=[q("i"), q("ii")])
    paper = Group(rule="any", count=1, children=[option_a, q("11b")])

    assert paper_maximum(paper, {"i": 8, "ii": 5, "11b": 13}) == 13
    assert score(paper, {"i": 7, "ii": 4, "11b": 10}) == (11, ["i", "ii"])
    assert score(paper, {"i": 7, "ii": 0, "11b": 10}) == (10, ["11b"])


def test_any_n_of_m_counts_the_best_n() -> None:
    part = Group(rule="any", count=2, children=[q("a"), q("b"), q("c"), q("d")])

    assert paper_maximum(part, {"a": 5, "b": 5, "c": 5, "d": 5}) == 10
    assert score(part, {"a": 1, "b": 4, "c": 3, "d": 4}) == (8, ["b", "d"])


def test_at_least_some_from_each_part() -> None:
    section_a = Group(label="A", children=[q("a1"), q("a2"), q("a3")])
    section_b = Group(label="B", children=[q("b1"), q("b2"), q("b3")])
    paper = Group(rule="any", count=3, min_each=1, children=[section_a, section_b])

    # The best three are all from A, but one must come from B.
    assert score(paper, {"a1": 9, "a2": 8, "a3": 7, "b1": 1, "b2": 2}) == (19, ["a1", "a2", "b2"])
    assert paper_maximum(paper, dict.fromkeys(["a1", "a2", "a3", "b1", "b2", "b3"], 10)) == 30


def test_one_from_each_module() -> None:
    modules = [Group(label=f"Module {n}", children=[q(f"{n}a"), q(f"{n}b")]) for n in (1, 2, 3)]
    paper = Group(rule="any", count=3, min_each=1, children=modules)

    assert score(paper, {"1a": 5, "1b": 7, "2a": 9, "3b": 2}) == (18, ["1b", "2a", "3b"])


def test_a_cap_limits_the_marks() -> None:
    paper = Group(cap=50, children=[q("a"), q("b")])

    assert paper_maximum(paper, {"a": 40, "b": 40}) == 50
    assert score(paper, {"a": 30, "b": 25})[0] == 50


def test_normalizing_keeps_every_question_once() -> None:
    paper = Group(children=[q("a"), q("gone"), Group(id="x", children=[q("a"), q("b")]), Group(id="x")])

    clean = normalize(paper, ["a", "b", "c"])

    assert clean.id == "root"
    assert question_order(clean) == ["a", "b", "c"]
    inner = [child for child in clean.children if isinstance(child, Group)]
    assert len({group.id for group in inner}) == 2


def test_mistakes_in_the_rules_are_pointed_out() -> None:
    paper = Group(
        children=[
            Group(label="Part B", rule="any", count=5, children=[q("a"), q("b")]),
            Group(label="12", rule="any", count=1, children=[q("c"), q("d")]),
        ]
    )

    assert rule_problems(paper, {"a": 1, "b": 1, "c": 16, "d": 12}) == [
        "Part B counts 5, but has only 2 to choose from.",
        "The choices in 12 are not worth the same marks.",
    ]


def kinds(node: Group | QuestionRef) -> Any:
    if isinstance(node, QuestionRef):
        return "q"
    rule = f"any {node.count}" + (f", {node.min_each} each" if node.min_each else "") if node.rule == "any" else "all"
    return (node.label, rule, [kinds(child) for child in node.children])


def leaf(number: str, marks: float = 2) -> dict[str, Any]:
    return {"number": number, "question": f"Question {number}", "answer": "", "key": "", "max_marks": marks}


def test_the_key_reader_keeps_sections_and_choices() -> None:
    key = parse_answer_key(
        {
            "name": "Maths",
            "questions": [
                {"number": "Part A", "question": "Answer all questions.", "parts": [leaf("1"), leaf("2")]},
                {
                    "number": "Part B",
                    "question": "Answer any one.",
                    "parts": [
                        {"number": "11", "rule": "either/or", "parts": [leaf("a", 13), leaf("b", 13)]},
                        leaf("12", 13),
                    ],
                },
            ],
        }
    )

    assert [question.number for question in key.questions] == ["1", "2", "11 (a)", "11 (b)", "12"]
    assert key.structure is not None
    assert kinds(key.structure) == (
        "",
        "all",
        [("Part A", "all", ["q", "q"]), ("Part B", "any 1", [("11", "any 1", ["q", "q"]), "q"])],
    )


@pytest.mark.parametrize(
    ("rule", "instructions", "expected"),
    [
        ("any 3", "", "any 3"),
        ("", "Answer any THREE questions.", "any 3"),
        ("", "Answer ALL questions.", "all"),
        ("", "Answer five full questions, choosing one full question from each module.", "any 5, 1 each"),
        ("any six, at least two from each", "", "any 6, 2 each"),
        ("OR", "", "any 1"),
        ("compulsory", "Answer any two", "all"),
        ("", "Answer any eight", "all"),  # Only so many parts: all of them count.
    ],
)
def test_rules_are_read_from_their_wording(rule: str, instructions: str, expected: str) -> None:
    modules = [{"number": f"Module {n}", "parts": [leaf(f"{n}a"), leaf(f"{n}b")]} for n in range(1, 6)]
    key = parse_answer_key(
        {"questions": [{"number": "Part B", "question": instructions, "rule": rule, "parts": modules}]}
    )

    assert key.structure is not None
    (part,) = key.structure.children
    assert isinstance(part, Group)
    assert kinds(part)[1] == expected


def test_a_saved_key_keeps_its_groups_and_totals_count_choices_once(client: TestClient) -> None:
    questions = [leaf("1", 2), leaf("11 (a)", 13), leaf("11 (b)", 13)]
    exam = client.post("/api/exams", json={"name": "Paper", "questions": questions}).json()
    one, a, b = (question["id"] for question in exam["questions"])
    assert exam["total_marks"] == 28
    structure = {
        "children": [
            {"kind": "question", "question_id": one},
            {
                "kind": "group",
                "label": "11",
                "rule": "any",
                "count": 1,
                "children": [
                    {"kind": "question", "question_id": b},
                    {"kind": "question", "question_id": a},
                ],
            },
        ]
    }

    saved = client.put(
        f"/api/exams/{exam['id']}", json={"name": "Paper", "questions": exam["questions"], "structure": structure}
    ).json()

    assert saved["total_marks"] == 15
    # The questions follow the paper's order.
    assert [question["number"] for question in saved["questions"]] == ["1", "11 (b)", "11 (a)"]
    assert saved["structure"]["id"] == "root"
    assert saved["structure"]["children"][1]["label"] == "11"
    assert client.get("/api/exams").json()[0]["total_marks"] == 15


def test_a_student_who_answers_both_choices_gets_the_better_one(client: TestClient, fake_ollama: FakeOllama) -> None:
    questions = [leaf("1", 2), leaf("11 (a)", 13), leaf("11 (b)", 13)]
    exam = client.post("/api/exams", json={"name": "Paper", "questions": questions}).json()
    one, a, b = (question["id"] for question in exam["questions"])
    document = upload(client, make_pdf(page_count=1), filename="ravi.pdf").json()
    give_text(client, document["id"], ["1. two\n11 (a) first try\n11 (b) second try"])
    marks = {"1": 2, "11 (a)": 6, "11 (b)": 9}

    def reply(payload: dict[str, Any]) -> Any:
        system, prompt = (message["content"] for message in payload["messages"])
        if "split" in system:
            return {
                "answers": [
                    {"question": "Q1", "pages": [1], "answer": "two"},
                    {"question": "Q2", "pages": [1], "answer": "first try"},
                    {"question": "Q3", "pages": [1], "answer": "second try"},
                ]
            }
        number = prompt.split(" (maximum")[0].removeprefix("Question ")
        return {"feedback": "", "marks": marks[number]}

    fake_ollama.json_reply = reply
    evaluation = evaluate(client, document, exam)[-1]["evaluation"]
    # Before the key has the choice, every answer counts.
    assert (evaluation["marks"], evaluation["max_marks"], evaluation["not_counted"]) == (17, 28, [])

    structure = {
        "children": [
            {"kind": "question", "question_id": one},
            {
                "kind": "group",
                "label": "11",
                "rule": "any",
                "count": 1,
                "children": [
                    {"kind": "question", "question_id": a},
                    {"kind": "question", "question_id": b},
                ],
            },
        ]
    }
    client.put(
        f"/api/exams/{exam['id']}", json={"name": "Paper", "questions": exam["questions"], "structure": structure}
    )

    # Marks already given follow the key's new layout.
    evaluation = client.get(f"/api/evaluations/{evaluation['id']}").json()
    assert (evaluation["marks"], evaluation["max_marks"], evaluation["not_counted"]) == (11, 15, [a])
    (summary,) = client.get("/api/evaluations", params={"exam_id": exam["id"]}).json()
    assert (summary["marks"], summary["not_counted"]) == (11, [a])
    csv = client.get(f"/api/exams/{exam['id']}/results.csv").content.decode("utf-8-sig").splitlines()
    assert csv[1].endswith(",11,15,Q11 (a),yes")


def test_the_marking_ai_is_given_the_text_shared_by_a_question_s_group(
    client: TestClient, fake_ollama: FakeOllama
) -> None:
    exam = client.post("/api/exams", json={"name": "Paper", "questions": [leaf("11 (a)", 5)]}).json()
    (only,) = exam["questions"]
    structure = {
        "children": [
            {
                "kind": "group",
                "label": "11",
                "text": "Let $f(x) = x^2$.",
                "children": [{"kind": "question", "question_id": only["id"]}],
            }
        ]
    }
    client.put(f"/api/exams/{exam['id']}", json={"name": "Paper", "questions": [only], "structure": structure})
    document = upload(client, make_pdf(page_count=1), filename="ravi.pdf").json()
    give_text(client, document["id"], ["11 (a) 2x"])
    prompts: list[str] = []

    def reply(payload: dict[str, Any]) -> Any:
        system, prompt = (message["content"] for message in payload["messages"])
        if "split" in system:
            return {"answers": [{"question": "Q1", "pages": [1], "answer": "2x"}]}
        prompts.append(prompt)
        return {"feedback": "", "marks": 5}

    fake_ollama.json_reply = reply
    evaluate(client, document, exam)

    (prompt,) = prompts
    assert "Let $f(x) = x^2$.\n\nQuestion 11 (a)" in prompt
