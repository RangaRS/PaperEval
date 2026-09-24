from __future__ import annotations

import pytest

from app.llm_json import loads_llm_json


def test_plain_json() -> None:
    assert loads_llm_json('{"marks": 1.5, "feedback": "ok"}') == {"marks": 1.5, "feedback": "ok"}


def test_json_in_a_code_block_or_among_other_text() -> None:
    assert loads_llm_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert loads_llm_json('Here you go:\n{"a": 1}\nHope that helps.') == {"a": 1}


def test_properly_escaped_latex_is_unchanged() -> None:
    assert loads_llm_json(r'{"text": "$\\frac{1}{2}$ and $\\theta$"}') == {"text": r"$\frac{1}{2}$ and $\theta$"}


@pytest.mark.parametrize(
    "latex",
    [r"\frac{dx}{x}", r"\theta", r"\times", r"\tan x", r"\therefore", r"\neq", r"\nabla", r"\nu", r"\beta", r"\right)"],
)
def test_latex_commands_that_look_like_json_escapes_are_kept(latex: str) -> None:
    raw = '{"text": "$' + latex + '$"}'

    assert loads_llm_json(raw) == {"text": f"${latex}$"}


def test_latex_that_is_not_a_json_escape_is_kept() -> None:
    raw = r'{"text": "$\alpha + \sqrt{2} \int_0^1 \{x\} \, dx$"}'

    assert loads_llm_json(raw) == {"text": r"$\alpha + \sqrt{2} \int_0^1 \{x\} \, dx$"}


def test_real_escapes_still_work() -> None:
    raw = r'{"text": "line one\nThe next line\tTabbed \"quoted\" é"}'

    assert loads_llm_json(raw) == {"text": 'line one\nThe next line\tTabbed "quoted" é'}


def test_raw_line_breaks_inside_strings_are_accepted() -> None:
    assert loads_llm_json('{"text": "first\nsecond"}') == {"text": "first\nsecond"}


def test_the_users_sample_survives() -> None:
    answer = r"The auxiliary eqn is $\frac{dx}{x} = \frac{dy}{y}$. $\therefore a_n=0$. Hence $\phi(\frac{x}{y})=0$"
    raw = '{"answer": "' + answer + '"}'

    assert loads_llm_json(raw)["answer"] == answer


def test_not_json_at_all() -> None:
    with pytest.raises(ValueError):
        loads_llm_json("I could not read the page.")


def test_a_list_and_a_code_block_after_other_text() -> None:
    assert loads_llm_json('[{"a": 1}, {"a": 2}]') == [{"a": 1}, {"a": 2}]
    assert loads_llm_json('The key:\n[{"a": 1}, {"a": 2}]\nDone.') == [{"a": 1}, {"a": 2}]
    assert loads_llm_json('Sure! Here it is:\n```json\n{"a": [1, 2]}\n```\nAnything else?') == {"a": [1, 2]}
