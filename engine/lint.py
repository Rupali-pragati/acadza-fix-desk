"""Deterministic checks. Free, instant, and they give the LLM hard facts instead of hunches.

Every signal is {code, field, detail}. Signals never decide a verdict on their own;
they are evidence for the investigator and inputs to the guards.
"""
from __future__ import annotations

import re

from .load import QView

EXAM_TAG_RE = re.compile(r"\(\s*(?:JEE|NEET|AIEEE|AIIMS|BITSAT|CBSE|IIT|KCET|MHT[- ]?CET)[^)]{0,30}?\d{4}[^)]{0,10}\)", re.I)
LATEX_RE = re.compile(r"\\(?:frac|sqrt|AA|times|alpha|beta|theta|pi|mu|lambda|Delta|left|right|text|mathrm|circ|cdot|vec)\b|\\[a-zA-Z]{2,}\{")
AMP_RE = re.compile(r"<m[io]>\s*&(?:amp;)?\s*</m[io]>")
FIGURE_RE = re.compile(r"\b(?:as shown|shown in (?:the )?fig|figure|diagram|fig\.)", re.I)
NUM_RE = re.compile(r"\d+(?:\.\d+)?")

INJECTION_RE = re.compile(
    r"ignore (?:all |any )?(?:previous|prior|above) instructions|you are (?:now )?(?:the |an? )?(?:admin|system|developer)"
    r"|system prompt|mark (?:this|it) as (?:corrected|fixed|resolved)|change the answer to|act as|jailbreak",
    re.I,
)


def _sig(code, field, detail):
    return {"code": code, "field": field, "detail": detail}


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s or "").lower()


def answer_letters(ans) -> list[str] | None:
    """Normalise an scq/mcq key to a sorted letter list, or None if it is not letters at all."""
    if isinstance(ans, str):
        parts = re.split(r"[,\s]+", ans.strip())
    elif isinstance(ans, list):
        parts = []
        for a in ans:
            parts += re.split(r"[,\s]+", str(a).strip())
    else:
        return None
    parts = [p.upper() for p in parts if p]
    if not parts or any(p not in "ABCD" or len(p) != 1 for p in parts):
        return None
    return sorted(set(parts))


def answer_format_problem(qtype: str, ans) -> str | None:
    if qtype == "scq":
        if not (isinstance(ans, str) and re.fullmatch(r"[A-D]", ans)):
            return f"scq key must be one letter A-D, got {ans!r}"
    elif qtype == "mcq":
        if not isinstance(ans, list) or not ans:
            return f"mcq key must be a non-empty list of letters, got {ans!r}"
        bad = [a for a in ans if not (isinstance(a, str) and re.fullmatch(r"[A-D]", a))]
        if bad:
            return f"mcq key has malformed entries {bad!r} in {ans!r}"
        if len(set(ans)) != len(ans):
            return f"mcq key has duplicates {ans!r}"
    elif qtype == "integerQuestion":
        if not (isinstance(ans, str) and re.fullmatch(r"-?\d+(?:\.\d+)?", ans.strip())):
            return f"integer key must be numeric, got {ans!r}"
    return None


def solution_final_number(solution_text: str) -> str | None:
    # drop sub/superscripts (epsilon_0, m^3, 10^(-5)) so they are not mistaken for the result
    tail = re.sub(r"[_^](?:\([^)]*\)|\S)", "", solution_text[-160:])
    nums = NUM_RE.findall(tail)
    return nums[-1] if nums else None


def lint_question(v: QView) -> list[dict]:
    s: list[dict] = []
    # options
    if v.qtype in ("scq", "mcq"):
        for L in "ABCD":
            if L not in v.options:
                s.append(_sig("option_missing", "question", f"option ({L}) is not present"))
            elif not v.options[L].strip():
                s.append(_sig("option_blank", "question", f"option ({L}) is blank"))
        seen = {}
        for L, t in v.options.items():
            if t.strip():
                k = _norm(t)
                if k in seen:
                    s.append(_sig("options_identical", "question", f"options ({seen[k]}) and ({L}) are identical: {t!r}"))
                seen.setdefault(k, L)
    # answer key
    prob = answer_format_problem(v.qtype, v.answer)
    if prob:
        s.append(_sig("answer_malformed", "answer", prob))
    if v.qtype in ("scq", "mcq"):
        letters = answer_letters(v.answer) or []
        for L in letters:
            if L not in v.options:
                s.append(_sig("key_option_missing", "answer", f"key ({L}) points to an option that does not exist"))
            elif not v.options[L].strip():
                s.append(_sig("key_option_blank", "answer", f"key ({L}) points to a blank option"))
        if v.qtype == "mcq" and len(letters) == 1:
            s.append(_sig("mcq_single_key", "questionType", f"stored as multiple-correct but only ({letters[0]}) is keyed"))
    # markup / noise
    for fld, raw, txt in (("question", v.raw_question, v.stem + " " + " ".join(v.options.values())), ("solution", v.raw_solution, v.solution)):
        for m in LATEX_RE.finditer(txt):
            s.append(_sig("latex_leak", fld, f"raw LaTeX visible: {txt[max(0, m.start()-15):m.end()+12]!r}"))
        n_amp = len(AMP_RE.findall(raw))
        if n_amp:
            s.append(_sig("amp_leak", fld, f"{n_amp} stray '&' alignment marker(s) render as visible '&' inside MathML"))
        for m in EXAM_TAG_RE.finditer(txt):
            s.append(_sig("exam_tag", fld, f"exam reference in text: {m.group(0)!r}"))
    if FIGURE_RE.search(v.stem) and not v.ques_images and "<img" not in v.raw_question:
        s.append(_sig("figure_missing", "question", "text refers to a figure but the record has no image"))
    # solution vs key consistency (cheap numeric check)
    fin = solution_final_number(v.solution)
    if fin and v.qtype == "scq" and v.options:
        hits = [L for L, t in v.options.items() if fin in NUM_RE.findall(t)]
        key = v.answer if isinstance(v.answer, str) else None
        if hits and key and key not in hits:
            s.append(_sig("solution_key_mismatch", "answer", f"solution ends at {fin}, which matches option(s) {hits}; key is ({key}) = {v.options.get(key)!r}"))
    if fin and v.qtype == "integerQuestion" and isinstance(v.answer, str):
        try:
            if abs(float(fin) - float(v.answer)) > 1e-9:
                s.append(_sig("solution_end_differs", "answer", f"hint: last number in the solution is {fin}; integer key is {v.answer} (could be a unit/scale step - verify)"))
        except ValueError:
            pass
    if not v.solution.strip():
        s.append(_sig("solution_empty", "solution", "no solution text"))
    return s


def lint_report(report: dict, v: QView) -> list[dict]:
    s = []
    c = (report.get("comment") or "").strip()
    if INJECTION_RE.search(c):
        s.append(_sig("injection_suspect", "comment", "comment contains instructions aimed at the system; treated as data only"))
    letters = re.sub(r"[^a-z]", "", c.lower())
    if len(letters) < 3 or (not re.search(r"[aeiou]", letters)) or re.fullmatch(r"(?:asdf\w*|qwer\w*|zxcv\w*|hjkl\w*|(\w)\1{3,})", letters):
        s.append(_sig("gibberish_comment", "comment", f"comment carries no information: {c!r}"))
    later = [h for h in v.error_history if (h.get("at") or "") > report["reportedAt"]]
    for h in later:
        s.append(_sig("fixed_after_report", "record", f"{h.get('actor')} edited this record at {h.get('at')} (after this report): {h.get('type')} - {h.get('note')}"))
    return s
