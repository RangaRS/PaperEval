"""Read JSON written by a language model, keeping LaTeX intact."""

from __future__ import annotations

import json
import re
from typing import Any

# LaTeX commands that start with a letter JSON also uses as an escape (\b \f \n
# \r \t \u). A model that writes "\frac" inside a JSON string without doubling
# the backslash would otherwise get a form feed followed by "rac".
_LATEX_COMMANDS = frozenset(
    """
    bar beta because begin big Big bigg Bigg bigcap bigcup bigl bigr binom bmod boldsymbol bot bowtie box boxed breve
    bullet bf
    fbox flat forall frac frown
    nabla natural ne nearrow neg neq newline nexists ngeq ni nleq nmid noindent nolimits not notin nparallel nsubseteq
    nu nwarrow
    rangle rbrace rbrack rceil rfloor rho right rightarrow rightleftharpoons rm rvert rVert
    tan tanh tau tbinom text textbf textit textrm textstyle tfrac therefore theta tilde times to top triangle
    triangleleft triangleright tt twoheadrightarrow
    underbrace underline underset unit uparrow updownarrow uplus upsilon
    """.split()  # noqa: SIM905 - a word list reads better than 90 quoted strings
)
_LETTERS = re.compile(r"[A-Za-z]+")
_HEX4 = re.compile(r"[0-9a-fA-F]{4}")
_FENCE = re.compile(r"^```[a-zA-Z]*\s*\n(.*?)\n?```$", re.DOTALL)


def loads_llm_json(text: str) -> Any:
    """Parse the JSON object in a model's answer.

    Accepts answers wrapped in a Markdown code block or surrounded by other
    text, raw line breaks inside strings, and LaTeX whose backslashes were not
    escaped. Raises ValueError when no JSON object can be read.
    """
    text = text.strip()
    fenced = _FENCE.match(text)
    if fenced:
        text = fenced.group(1).strip()
    candidates = [text]
    start, end = text.find("{"), text.rfind("}")
    if 0 <= start < end:
        candidates.append(text[start : end + 1])
    for candidate in candidates:
        try:
            return json.loads(_escape_latex(candidate), strict=False)
        except json.JSONDecodeError:
            continue
    raise ValueError("The answer is not valid JSON.")


def _escape_latex(raw: str) -> str:
    """Double the backslashes of LaTeX commands inside JSON strings, leaving real escapes alone."""
    out: list[str] = []
    in_string = False
    i = 0
    while i < len(raw):
        char = raw[i]
        if not in_string:
            in_string = char == '"'
            out.append(char)
            i += 1
            continue
        if char == '"':
            in_string = False
            out.append(char)
            i += 1
            continue
        if char != "\\":
            out.append(char)
            i += 1
            continue
        following = raw[i + 1 : i + 2]
        if following in ('"', "\\", "/"):
            out.append(raw[i : i + 2])
            i += 2
        elif following == "u" and _HEX4.match(raw, i + 2):
            out.append(raw[i : i + 6])
            i += 6
        elif following in ("b", "f", "n", "r", "t") and not _is_latex_command(raw, i + 1):
            out.append(raw[i : i + 2])
            i += 2
        else:
            # Not a JSON escape (\alpha, \sqrt, \{, \,) or a LaTeX command: keep the backslash.
            out.append("\\\\")
            i += 1
    return "".join(out)


def _is_latex_command(raw: str, start: int) -> bool:
    letters = _LETTERS.match(raw, start)
    return bool(letters) and letters.group(0) in _LATEX_COMMANDS
