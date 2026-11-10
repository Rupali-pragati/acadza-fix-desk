"""CLI.

  python -m engine run              live run (uses the cache first, calls Gemini for anything new)
  python -m engine run --replay     rebuild everything from the committed cache, no API key needed
  python -m engine run --refresh    ignore the cache and re-ask the model
  python -m engine run --manual     no API: write uncached prompts to engine/pending/ (answered by a stand-in, declared)
  python -m engine answer           move stand-in answers into the cache (marked answeredBy)
  python -m engine run --regemini   re-ask Gemini for every stand-in answer
  python -m engine run --only R004  one report (or question id); prints, writes nothing
  python -m engine eval             score results.json against eval/expected.json (my hand labels)
  python -m engine lint             deterministic checks only, no LLM
  python -m engine models           list Gemini models your key can use
"""
from __future__ import annotations

import argparse
import json
import sys

from .load import ROOT, QView, load_all


def cmd_eval():
    exp = {e["reportId"]: e for e in json.loads((ROOT / "eval" / "expected.json").read_text(encoding="utf-8"))}
    got = {r["reportId"]: r for r in json.loads((ROOT / "results.json").read_text(encoding="utf-8"))}
    n = len(exp)
    v = sum(got.get(k, {}).get("verdict") == e["verdict"] for k, e in exp.items())
    rp = sum(got.get(k, {}).get("repair") == e["repair"] for k, e in exp.items())
    ro = sum(got.get(k, {}).get("route") == e["route"] for k, e in exp.items())
    unsafe = [k for k, e in exp.items() if got.get(k, {}).get("route") == "auto_apply" and e["route"] != "auto_apply"]
    print(f"verdict {v}/{n}   repair {rp}/{n}   route {ro}/{n}   unsafe auto-applies: {len(unsafe)} {unsafe}")
    print("\nmismatches:")
    for k, e in sorted(exp.items()):
        g = got.get(k, {})
        if (g.get("verdict"), g.get("repair"), g.get("route")) != (e["verdict"], e["repair"], e["route"]):
            print(f"  {k}: got {g.get('verdict')}/{g.get('repair')}/{g.get('route')}  expected {e['verdict']}/{e['repair']}/{e['route']}   ({e.get('why', '')})")


def cmd_lint():
    from .lint import lint_question, lint_report
    Q, R, _ = load_all()
    for qid, q in Q.items():
        for s in lint_question(QView.of(q)):
            print(f"{qid} {s['code']:<22} {s['detail']}")
    for r in R:
        for s in lint_report(r, QView.of(Q[r["questionId"]])):
            print(f"{r['reportId']:<24} {s['code']:<22} {s['detail']}")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="engine")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    g = r.add_mutually_exclusive_group()
    g.add_argument("--replay", action="store_true")
    g.add_argument("--refresh", action="store_true")
    g.add_argument("--manual", action="store_true", help="no API: park uncached prompts in engine/pending/ for a stand-in to answer")
    g.add_argument("--regemini", action="store_true", help="re-ask Gemini for every stand-in answer, keep real Gemini ones")
    r.add_argument("--only", nargs="*")
    r.add_argument("--no-audit", action="store_true", help="skip the proactive audit of unreported questions")
    sub.add_parser("answer", help="cache the stand-in answers in engine/pending/*/*.response.json")
    sub.add_parser("eval")
    sub.add_parser("lint")
    sub.add_parser("models")
    a = ap.parse_args(argv)
    if a.cmd == "run":
        from .pipeline import run
        mode = next((m for m in ("replay", "refresh", "manual", "regemini") if getattr(a, m)), "live")
        run(mode, set(a.only) if a.only else None, not a.no_audit)
    elif a.cmd == "answer":
        from .llm import answer_pending
        print(f"cached {answer_pending()} answer(s)")
    elif a.cmd == "eval":
        cmd_eval()
    elif a.cmd == "lint":
        cmd_lint()
    elif a.cmd == "models":
        from .llm import LLM
        print("\n".join(LLM().list_models()))


if __name__ == "__main__":
    sys.exit(main())
