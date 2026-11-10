"""The safety layer must hold without any LLM. These use real records from data/."""
import pytest

from engine.guards import apply_edits, check_issue
from engine.lint import lint_question, lint_report
from engine.load import QView, load_all, split_options

Q, R, T = load_all()
LCR = "60f744b3f1b9bc7cc7b4a949"
SOLVE_A = {"primary": {"answer": "A", "final_value": "50 V", "confidence": 0.95}, "check": {"answer": "A", "final_value": "50 V"}}


def issue(repair, edits, conf=0.95, verdict="defect"):
    return {"id": "I1", "verdict": verdict, "repair": repair, "edits": edits, "confidence": conf}


def test_answer_key_with_two_agreeing_solves_auto_applies():
    out = check_issue(issue("answer_key", [{"field": "answer", "find": "C", "replace": "A"}]), Q[LCR], T, SOLVE_A, False)
    assert out["auto_ok"], [g for g in out["guards"] if not g["ok"]]
    assert out["after"]["scq"]["answer"] == "A"


def test_answer_key_without_second_solve_is_held():
    solves = {"primary": SOLVE_A["primary"]}
    out = check_issue(issue("answer_key", [{"field": "answer", "find": "C", "replace": "A"}]), Q[LCR], T, solves, False)
    assert not out["auto_ok"]


def test_answer_key_that_the_solver_rejects_is_held():
    # the student-suggested value is not what the blind solve found
    out = check_issue(issue("answer_key", [{"field": "answer", "find": "C", "replace": "B"}]), Q[LCR], T, SOLVE_A, False)
    assert not out["auto_ok"]


def test_edit_outside_repair_scope_is_blocked():
    e = [{"field": "answer", "find": "A", "replace": "B"}]
    out = check_issue(issue("spelling", e), Q["61dffbec08489156b684bd22"], T, {}, False)
    assert not out["auto_ok"]
    assert not next(g for g in out["guards"] if g["name"] == "scope")["ok"]


def test_spelling_fix_passes_but_number_change_disguised_as_spelling_fails():
    rec = Q["61dffbec08489156b684bd22"]
    good = check_issue(issue("spelling", [{"field": "question", "find": "Epithellial tisue", "replace": "Epithelial tissue"}]), rec, T, {}, False)
    assert good["auto_ok"], [g for g in good["guards"] if not g["ok"]]
    rec2 = Q[LCR]
    bad = check_issue(issue("spelling", [{"field": "question", "find": "60 V", "replace": "50 V"}]), rec2, T, {}, False)
    assert not bad["auto_ok"]


def test_find_must_match_exactly_once():
    _, errs = apply_edits(Q[LCR], [{"field": "question", "find": "V", "replace": "volt"}])
    assert errs and "occurs" in errs[0]


def test_auto_false_repair_never_auto_applies():
    e = [{"field": "question", "find": "(C) 0 W", "replace": "(C) 500 W"}]
    out = check_issue(issue("identical_options", e), Q["6956d79788d7701e5617bc29"], T, {}, False)
    assert not out["auto_ok"]


def test_stem_data_value_must_come_from_solution():
    rec = Q["60f742f6660d187cc13a8078"]
    ok = check_issue(issue("stem_data", [{"field": "question", "find": "an inductance are", "replace": "an inductance of 95.5 mH are"}]), rec, T, {}, False)
    assert ok["auto_ok"], [g for g in ok["guards"] if not g["ok"]]
    bad = check_issue(issue("stem_data", [{"field": "question", "find": "an inductance are", "replace": "an inductance of 0.1 H are"}]), rec, T, {}, False)
    assert not bad["auto_ok"]


def test_low_confidence_is_held():
    rec = Q["61dffbec08489156b684bd22"]
    out = check_issue(issue("spelling", [{"field": "question", "find": "Epithellial tisue", "replace": "Epithelial tissue"}], conf=0.6), rec, T, {}, False)
    assert not out["auto_ok"]


def test_injection_cannot_move_the_key_without_solver_support():
    rec = Q["6062ec84518e9535e120c422"]
    solves = {"primary": {"answer": "A"}, "check": {"answer": "C"}}
    out = check_issue(issue("answer_key", [{"field": "answer", "find": "A", "replace": "C"}]), rec, T, solves, True)
    assert not out["auto_ok"]


def test_type_mismatch_moves_body_and_sets_scq_key():
    rec = Q["68f21caf941cda588bc04365"]
    edits = [{"field": "questionType", "find": "mcq", "replace": "scq"}, {"field": "answer", "find": ["", "B"], "replace": "B"}]
    out = check_issue(issue("type_mismatch", edits), rec, T, {"primary": {"answer": "B"}}, False)
    assert out["auto_ok"], [g for g in out["guards"] if not g["ok"]]
    assert out["after"]["questionType"] == "scq" and out["after"]["scq"]["answer"] == "B" and "mcq" not in out["after"]


def test_lint_catches_planted_structural_defects():
    codes = lambda qid: {s["code"] for s in lint_question(QView.of(Q[qid]))}  # noqa: E731
    assert "option_blank" in codes("68e872546e45ba37dcc16bc0")
    assert "option_missing" in codes("622f08d7b70e4b50e4500a1b")
    assert "options_identical" in codes("6956d79788d7701e5617bc29")
    assert "answer_malformed" in codes("68c8153cfb6b2f16e2d3ceaf")
    assert "latex_leak" in codes("63765a28f1d8416ae0408d89")
    assert "exam_tag" in codes("617fa18efd53ff1629ed890f")
    assert "figure_missing" in codes("622df25ab70e4b50e44ff837")
    assert "solution_key_mismatch" in codes(LCR)


def test_report_flags():
    rep = {r["reportId"]: r for r in R}
    f = lambda rid: {s["code"] for s in lint_report(rep[rid], QView.of(Q[rep[rid]["questionId"]]))}  # noqa: E731
    assert "injection_suspect" in f("R027")
    assert "gibberish_comment" in f("R041")
    assert "fixed_after_report" in f("R017")
    assert not f("R001")


def test_option_split_keeps_assertion_label_in_stem():
    stem, opts = split_options("Assertion (A): x\nReason (R): y\n(A) one\n(B) two\n(C) three\n(D) four")
    assert stem.startswith("Assertion (A)") and list(opts) == ["A", "B", "C", "D"]
