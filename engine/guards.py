"""Deterministic safety layer. The LLM proposes; these checks decide whether it may auto-apply.

Every guard returns {name, ok, detail}. All guards run (even after one fails) so the console
can show a faculty member the full picture, not just the first problem.
"""
from __future__ import annotations

import copy
import json
import re
from collections import Counter

from .lint import EXAM_TAG_RE, LATEX_RE, AMP_RE, answer_format_problem, answer_letters
from .load import QView, body, html_to_text

AUTO_CONFIDENCE = 0.85
NUM_RE = re.compile(r"\d+(?:\.\d+)?")
TEXT_FIELDS = ("question", "solution")
WHOLE_SOLUTION_REPAIRS = {"solution_fix", "solution_missing"}


def G(name, ok, detail=""):
    return {"name": name, "ok": bool(ok), "detail": detail}


# --------------------------------------------------------------------------- applying edits
def _same(a, b) -> bool:
    if isinstance(a, str) and not isinstance(b, str):
        try:
            a = json.loads(a)
        except (json.JSONDecodeError, TypeError):
            pass
    return a == b


def normalize_edit(e: dict) -> dict:
    """Models often JSON-encode key values ('"D"', '["A","B"]'). Decode them once, here."""
    e = dict(e)
    if e.get("field") in ("answer", "questionType"):
        for k in ("find", "replace"):
            v = e.get(k)
            if isinstance(v, str) and v.strip()[:1] in ('"', "["):
                try:
                    e[k] = json.loads(v)
                except json.JSONDecodeError:
                    pass
    return e


def apply_edits(record: dict, edits: list[dict]) -> tuple[dict, list[str]]:
    """Return (new_record, errors). The input record is never mutated."""
    rec = copy.deepcopy(record)
    errors = []
    edits = [normalize_edit(e) for e in edits]
    for e in sorted(edits, key=lambda e: e.get("field") != "questionType"):
        f, find, rep = e.get("field"), e.get("find"), e.get("replace")
        if f == "questionType":
            old = rec["questionType"]
            if find != old:
                errors.append(f"questionType find={find!r} but record is {old!r}")
                continue
            if rep not in ("scq", "mcq", "integerQuestion"):
                errors.append(f"unknown questionType {rep!r}")
                continue
            rec[rep] = rec.pop(old)
            rec["questionType"] = rep
        elif f == "answer":
            cur = body(rec).get("answer")
            if not (_same(find, cur) or _same(find, json.dumps(cur))):
                errors.append(f"answer find={find!r} does not equal stored key {cur!r}")
                continue
            body(rec)["answer"] = rep
        elif f in TEXT_FIELDS:
            cur = body(rec).get(f) or ""
            if not isinstance(find, str) or not find:
                errors.append(f"{f}: empty find")
                continue
            n = cur.count(find)
            if n != 1:
                errors.append(f"{f}: find text occurs {n} times (must be exactly once): {find[:80]!r}")
                continue
            body(rec)[f] = cur.replace(find, rep or "", 1)
        else:
            errors.append(f"field {f!r} cannot be edited")
    return rec, errors


# --------------------------------------------------------------------------- helpers
def _vis(html: str) -> str:
    return html_to_text(html or "")


def _nums(s: str) -> list[str]:
    return NUM_RE.findall(s or "")


def _insertions(find: str, replace: str) -> str | None:
    """Text added by an edit that only inserts (None if anything was deleted or changed)."""
    import difflib
    sm = difflib.SequenceMatcher(None, find or "", replace or "", autojunk=False)
    added = []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "insert":
            added.append((replace or "")[j1:j2])
        elif op != "equal":
            return None
    return " ".join(added)


def _is_subsequence(small: str, big: str) -> bool:
    it = iter(big)
    return all(ch in it for ch in small)


def norm_answer(qtype: str, ans):
    if ans is None:
        return None
    if qtype in ("scq", "mcq"):
        if isinstance(ans, str) and qtype == "scq":
            m = re.fullmatch(r"\s*\(?([A-Da-d])\)?\s*", ans)
            return [m.group(1).upper()] if m else answer_letters(ans)
        return answer_letters(ans)
    m = NUM_RE.search(str(ans))
    return float(m.group(0)) if m else None


def solver_agrees(qtype: str, solve: dict | None, ans) -> bool | None:
    """True/False if the solver gave a usable answer, None if it abstained."""
    if not solve or solve.get("answer") in (None, "", []):
        return None
    a, b = norm_answer(qtype, solve.get("answer")), norm_answer(qtype, ans)
    if a is None or b is None:
        return None
    if isinstance(a, float):
        return abs(a - b) <= max(1e-6, 0.01 * abs(b))
    return a == b


# --------------------------------------------------------------------------- the guards
def check_issue(issue: dict, record: dict, taxonomy: dict, solves: dict, injection: bool) -> dict:
    """Run every guard for one proposed issue. Returns {guards, auto_ok, after, apply_errors}."""
    guards: list[dict] = []
    verdict, repair, edits = issue.get("verdict"), issue.get("repair"), issue.get("edits") or []
    rep_def = taxonomy["repairs"].get(repair) if repair else None
    qtype = record["questionType"]
    v_before = QView.of(record)

    guards.append(G("taxonomy", verdict in taxonomy["verdicts"] and (repair is None or rep_def is not None),
                    f"verdict={verdict} repair={repair}"))
    if verdict != "defect":
        guards.append(G("no_edit_for_non_defect", not edits, "non-defect verdicts must not edit the record"))
        return {"guards": guards, "auto_ok": False, "after": None, "apply_errors": []}

    guards.append(G("repair_chosen", rep_def is not None, "a defect needs a repair type"))
    if rep_def is None:
        return {"guards": guards, "auto_ok": False, "after": None, "apply_errors": []}

    allowed = set(rep_def["fields"])
    out_of_scope = [e.get("field") for e in edits if e.get("field") not in allowed]
    guards.append(G("scope", not out_of_scope,
                    f"edits touch {sorted({e.get('field') for e in edits})}; {repair} may touch {sorted(allowed) or 'nothing'}"))
    guards.append(G("taxonomy_allows_auto", rep_def["auto"], "auto: true" if rep_def["auto"] else "auto: false - faculty must approve"))
    guards.append(G("has_edit", bool(edits) or not rep_def["auto"], f"{len(edits)} edit(s)"))

    after, errs = apply_edits(record, edits) if edits and not out_of_scope else (None, [])
    guards.append(G("applies_cleanly", not errs, "; ".join(errs) or "every find matched exactly once"))
    if errs:
        after = None

    conf = float(issue.get("confidence") or 0)
    guards.append(G("confidence", conf >= AUTO_CONFIDENCE, f"{conf:.2f} (auto needs >= {AUTO_CONFIDENCE})"))

    if after is not None:
        guards += _repair_invariants(repair, edits, record, after, solves)
        if injection:
            changes_key = any(e.get("field") in ("answer", "questionType") for e in edits)
            ok = (not changes_key) or solver_agrees(after["questionType"], solves.get("primary"), body(after).get("answer")) is True
            guards.append(G("injection_isolated", ok, "report contained instructions; a key change is allowed only if the blind solve independently supports it"))
        if not any(g["name"] == "surgical" for g in guards):
            guards.append(_surgical(repair, record, after))

    auto_ok = all(g["ok"] for g in guards)
    return {"guards": guards, "auto_ok": auto_ok, "after": after, "apply_errors": errs}


def _surgical(repair, before, after):
    if repair in WHOLE_SOLUTION_REPAIRS:
        return G("surgical", True, "solution rewrite allowed for this repair")
    changed = 0
    for f in TEXT_FIELDS:
        a, b = body(before).get(f) or "", body(after).get(f) or ""
        if a != b:
            # size of the changed span
            i = 0
            while i < min(len(a), len(b)) and a[i] == b[i]:
                i += 1
            j = 0
            while j < min(len(a), len(b)) - i and a[-1 - j] == b[-1 - j]:
                j += 1
            changed += max(len(a) - i - j, len(b) - i - j)
    return G("surgical", changed <= 400, f"{changed} characters changed")


def _repair_invariants(repair, edits, before, after, solves) -> list[dict]:
    out = []
    vb, va = QView.of(before), QView.of(after)
    text_edits = [e for e in edits if e.get("field") in TEXT_FIELDS]
    fv = lambda e: _vis(e.get("find"))  # noqa: E731
    rv = lambda e: _vis(e.get("replace"))  # noqa: E731

    if repair == "spelling":
        ok = all(_nums(fv(e)) == _nums(rv(e)) and re.sub(r"[\w\s'’]", "", fv(e)) == re.sub(r"[\w\s'’]", "", rv(e))
                 and (e.get("find") or "").count("<math") == (e.get("replace") or "").count("<math") for e in text_edits)
        out.append(G("words_only", ok, "no number, symbol or math changed"))
    elif repair in ("noise", "exam_reference"):
        ok = all(_is_subsequence(rv(e), fv(e)) and len(rv(e)) < len(fv(e)) for e in text_edits)
        out.append(G("deletion_only", ok, "replacement only removes text"))
        if repair == "exam_reference":
            ok2 = all(EXAM_TAG_RE.search(fv(e)) and not EXAM_TAG_RE.search(rv(e)) for e in text_edits)
            out.append(G("removes_exam_tag", ok2, "removed text is an exam tag like (NEET 2019)"))
    elif repair == "markup_leak":
        ok = all((LATEX_RE.search(e.get("find") or "") or AMP_RE.search(e.get("find") or "")) for e in text_edits)
        ok2 = all(not LATEX_RE.search(rv(e)) for e in text_edits)
        ok3 = all(Counter(_nums(re.sub(r"\\[a-zA-Z]+", "", fv(e)))) == Counter(_nums(rv(e))) for e in text_edits)
        out.append(G("targets_leak", ok, "find contains raw LaTeX or a stray &"))
        out.append(G("leak_gone", ok2, "no raw LaTeX left in the replacement"))
        out.append(G("values_preserved", ok3, "same numbers before and after"))
    elif repair == "answer_form":
        ok = all(_insertions(e.get("find"), e.get("replace")) for e in text_edits)
        out.append(G("additive_only", ok, "replacement keeps the original text and only adds"))
    elif repair == "notation":
        ok = all(Counter(_nums(fv(e))) == Counter(_nums(rv(e))) for e in text_edits)
        out.append(G("values_preserved", ok, "same numbers before and after"))
    elif repair == "stem_data":
        ins = [_insertions(e.get("find"), e.get("replace")) for e in text_edits]
        ok = all(ins)
        added = [n for t in ins if t for n in _nums(_vis(t))]
        sol_nums = set(_nums(vb.solution))
        ok2 = bool(added) and all(n in sol_nums for n in added)
        out.append(G("additive_only", ok, "original stem text kept, value only added"))
        out.append(G("value_from_solution", ok2, f"added values {added} appear in the stored solution" if ok2 else f"added values {added} not all found in the solution"))
    elif repair == "option_repair":
        out.append(G("stem_unchanged", vb.stem == va.stem, "question stem text identical"))
        complete = all(va.options.get(L, "").strip() for L in "ABCD") and len(va.options) == 4
        distinct = len({re.sub(r"\s+", "", t).lower() for t in va.options.values()}) == len(va.options)
        out.append(G("options_complete", complete and distinct, f"options now: {va.options}"))
        changed = [L for L in "ABCD" if vb.options.get(L, "") != va.options.get(L, "")]
        key = answer_letters(body(after).get("answer")) or []
        p = solves.get("primary") or {}
        val_nums = _nums(str(p.get("final_value", "")))
        for L in changed:
            new_nums = _nums(va.options.get(L, ""))
            if L in key:
                out.append(G("restored_key_matches_solve", bool(new_nums) and new_nums == val_nums[: len(new_nums)],
                             f"restored ({L}) {va.options.get(L)!r} vs independent solve {p.get('final_value')!r}"))
            else:
                out.append(G("new_distractor_is_wrong", not (new_nums and new_nums == val_nums[: len(new_nums)]),
                             f"new ({L}) {va.options.get(L)!r} must differ from the correct value {p.get('final_value')!r}"))
    elif repair in WHOLE_SOLUTION_REPAIRS:
        key = body(after).get("answer")
        if after["questionType"] == "integerQuestion":
            target = [str(key)]
        else:
            target = [n for L in (answer_letters(key) or []) for n in _nums(va.options.get(L, ""))]
        tail = va.solution[-300:]
        ok = (not target) or all(t in _nums(tail) or t in tail for t in target)
        out.append(G("solution_ends_in_key", ok, f"new solution's ending contains the keyed value {target}"))
        agree = solver_agrees(after["questionType"], solves.get("primary"), key)
        out.append(G("solver_supports_key", agree is True, f"independent solve agrees with the key: {agree}"))
    elif repair == "answer_key":
        new = body(after).get("answer")
        fmt = answer_format_problem(after["questionType"], new)
        out.append(G("key_format_valid", fmt is None, fmt or "valid format"))
        a1 = solver_agrees(after["questionType"], solves.get("primary"), new)
        a2 = solver_agrees(after["questionType"], solves.get("check"), new)
        same_letters = norm_answer(before["questionType"], body(before).get("answer")) == norm_answer(after["questionType"], new)
        if same_letters:
            out.append(G("format_only_change", True, "same correct option(s), only the stored format changes"))
            out.append(G("solver_supports_key", a1 is True, f"blind solve agrees: {a1}"))
        else:
            out.append(G("two_independent_solves", a1 is True and a2 is True,
                         f"blind solve agrees: {a1}; second solve agrees: {a2}"))
            sol_ok = _solution_supports(va)
            out.append(G("stored_solution_consistent", sol_ok is not False,
                         "stored solution's final value matches the new key" if sol_ok else ("no numeric ending to compare" if sol_ok is None else "stored solution points elsewhere")))
    elif repair == "type_mismatch":
        new_t, new = after["questionType"], body(after).get("answer")
        fmt = answer_format_problem(new_t, new)
        out.append(G("key_format_valid", fmt is None, fmt or f"valid {new_t} key"))
        agree = solver_agrees(new_t, solves.get("primary"), new)
        out.append(G("solver_supports_key", agree is True, f"blind solve agrees with {new!r}: {agree}"))
    return out


def _solution_supports(va: QView):
    from .lint import solution_final_number
    fin = solution_final_number(va.solution)
    if not fin:
        return None
    if va.qtype == "integerQuestion":
        # the last number of a free-form solution is often not the asked quantity (n, 10A, cm vs m),
        # so for integers this can only ever confirm, never veto
        try:
            return True if abs(float(fin) - float(va.answer)) < 1e-6 else None
        except (TypeError, ValueError):
            return None
    letters = answer_letters(va.answer) or []
    return any(fin in _nums(va.options.get(L, "")) for L in letters)
