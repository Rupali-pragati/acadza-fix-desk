"""Loading the production data and turning messy HTML + MathML into text an LLM can read.

The raw HTML is always kept: edits are proposed and applied against the raw field,
the text form is only for reading (LLM prompts, lint, diffs).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

VOID = {"br", "img", "hr", "mspace", "mprescripts", "none", "meta", "input", "col", "wbr"}
BLOCK = {"br", "p", "h1", "h2", "h3", "h4", "h5", "h6", "div", "li", "tr", "table", "ul", "ol"}


# --------------------------------------------------------------------------- tiny DOM
@dataclass
class Node:
    tag: str
    attrs: dict = field(default_factory=dict)
    children: list = field(default_factory=list)  # Node | str


class _TreeBuilder(HTMLParser):
    """Forgiving parser: unclosed <span>s (very common in this data) are tolerated."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, dict(attrs))
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(Node(tag, dict(attrs)))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return
        # stray end tag: ignore

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def parse_html(html: str) -> Node:
    b = _TreeBuilder()
    b.feed(html or "")
    b.close()
    return b.root


# --------------------------------------------------------------------------- linearise
_SPACED_OPS = {"=", "+", "−", "-", "×", "⇒", "∴", "→", "≈", "<", ">", "≤", "≥", "∵", "÷"}


def _wrap(s: str) -> str:
    s = s.strip()
    if re.fullmatch(r"\d+(?:\.\d+)?|[^\s]", s):
        return s
    return f"({s})"


def _text(node, in_math=False) -> str:
    if isinstance(node, str):
        t = node.replace(" ", " ").replace("​", "")
        return t.strip() if in_math else t
    tag = node.tag
    kids = node.children
    math = in_math or tag == "math"

    def k(i):
        return _text(kids[i], math) if i < len(kids) else ""

    elems = [c for c in kids if isinstance(c, Node)]

    def e(i):
        return _text(elems[i], math) if i < len(elems) else ""

    if tag == "math":
        return " " + "".join(_text(c, True) for c in kids).strip() + " "
    if math:
        if tag == "mfrac":
            return f"{_wrap(e(0))}/{_wrap(e(1))}"
        if tag == "msup":
            base, sup = e(0).strip(), e(1).strip()
            if sup in ("∘", "o"):
                return f"{base}°"
            return f"{base}^{_wrap(sup)}"
        if tag == "msub":
            return f"{e(0).strip()}_{_wrap(e(1))}"
        if tag == "msubsup":
            return f"{e(0).strip()}_{_wrap(e(1))}^{_wrap(e(2))}"
        if tag == "msqrt":
            return f"√({''.join(_text(c, True) for c in kids).strip()})"
        if tag == "mroot":
            return f"root[{e(1)}]({e(0)})"
        if tag in ("mover", "munderover", "munder"):
            base, acc = e(0).strip(), e(1).strip()
            if acc in ("→", "⃗"):
                return f"vec({base})"
            if acc in ("¯", "‾", "_"):
                return f"bar({base})"
            return base + (f"^{_wrap(acc)}" if tag == "mover" else f"_{_wrap(acc)}")
        if tag == "mspace":
            return "\n" if node.attrs.get("linebreak") == "newline" else " "
        if tag == "mtr":
            return " ; ".join(_text(c, True) for c in kids if isinstance(c, Node)) + "\n"
        if tag == "mo":
            t = "".join(_text(c, True) for c in kids).strip()
            return f" {t} " if t in _SPACED_OPS else t
        if tag in ("mtext",):
            return "".join(c.replace(" ", " ") if isinstance(c, str) else _text(c, True) for c in kids)
        return "".join(_text(c, True) for c in kids)

    # plain html
    if tag == "img":
        return f" [image: {node.attrs.get('src', '')[:60]}] "
    if tag == "sup":
        inner = "".join(_text(c) for c in kids).strip()
        return "°" if inner in ("o", "0") else f"^{_wrap(inner)}"
    if tag == "sub":
        return f"_{_wrap(''.join(_text(c) for c in kids))}"
    inner = "".join(_text(c) for c in kids)
    if tag in BLOCK:
        return "\n" + inner + ("\n" if tag != "br" else "")
    return inner


def html_to_text(html: str) -> str:
    t = _text(parse_html(html or ""))
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r" *\n *", "\n", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


# --------------------------------------------------------------------------- questions
OPTION_RE = re.compile(r"(?:^|\n)[ \t]*\(([A-D])\)[ \t]*")


def split_options(text: str) -> tuple[str, dict]:
    """Return (stem, {letter: option_text}) from the visible text of a question field."""
    marks = list(OPTION_RE.finditer(text))
    if not marks:
        return text.strip(), {}
    stem = text[: marks[0].start()].strip()
    opts = {}
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        opts[m.group(1)] = re.sub(r"\s+", " ", text[m.end():end]).strip()
    return stem, opts


def body(q: dict) -> dict:
    return q.get(q["questionType"]) or {}


@dataclass
class QView:
    """Read-only, LLM-friendly view of one question record."""
    id: str
    qtype: str
    subject: str
    chapter: str
    level: str | None
    stem: str
    options: dict
    answer: object
    solution: str
    raw_question: str
    raw_solution: str
    ques_images: list
    sol_images: list
    error_history: list
    updated_at: str

    @classmethod
    def of(cls, q: dict) -> "QView":
        b = body(q)
        qtext = html_to_text(b.get("question") or "")
        stem, opts = split_options(qtext) if q["questionType"] in ("scq", "mcq") else (qtext, {})
        return cls(
            id=q["_id"], qtype=q["questionType"], subject=q.get("subject"), chapter=q.get("chapter"),
            level=q.get("level"), stem=stem, options=opts, answer=b.get("answer"),
            solution=html_to_text(b.get("solution") or ""), raw_question=b.get("question") or "",
            raw_solution=b.get("solution") or "", ques_images=b.get("quesImages") or [],
            sol_images=b.get("solutionImages") or [], error_history=q.get("errorHistory") or [],
            updated_at=q.get("updatedAt"),
        )

    def render_for_llm(self, with_key=True, with_solution=True) -> str:
        lines = [f"Type: {self.qtype}  ({TYPE_HELP[self.qtype]})", f"Subject: {self.subject} | Chapter: {self.chapter}", "",
                 "QUESTION:", self.stem]
        if self.options:
            lines.append("")
            for letter in "ABCD":
                if letter in self.options:
                    lines.append(f"({letter}) {self.options[letter] or '[BLANK - nothing shown to students]'}")
                else:
                    lines.append(f"({letter}) [MISSING - option not present in the record]")
        if self.ques_images:
            lines.append(f"\n[question has {len(self.ques_images)} image(s)]")
        if with_key:
            lines += ["", f"STORED ANSWER KEY: {json.dumps(self.answer, ensure_ascii=False)}"]
        if with_solution:
            lines += ["", "STORED SOLUTION:", self.solution or "[EMPTY]"]
        return "\n".join(lines)


TYPE_HELP = {
    "scq": "single correct: exactly one of A-D",
    "mcq": "multiple correct: one or more of A-D, answer is a list of letters",
    "integerQuestion": "numerical answer typed by the student",
}


def load_all(data_dir: Path = DATA):
    qs = json.loads((data_dir / "questions.json").read_text(encoding="utf-8"))
    reports = json.loads((data_dir / "reports.json").read_text(encoding="utf-8"))
    taxonomy = json.loads((data_dir / "taxonomy.json").read_text(encoding="utf-8"))
    return {q["_id"]: q for q in qs}, reports, taxonomy


def group_reports(reports: list) -> dict:
    """Duplicate reports on one question are investigated once."""
    groups: dict[str, list] = {}
    for r in sorted(reports, key=lambda r: r["reportedAt"]):
        groups.setdefault(r["questionId"], []).append(r)
    return groups
