"""What "most urgent" means.

A broken question keeps hurting every student who meets it until someone acts. So urgency is
the harm still accruing if nobody acts tonight:

    urgency = severity (how badly one encounter hurts a student)
            x reach    (how many students are hitting it: reports, recency)
            x needs_a_human (an auto-applied fix already stopped the bleeding)

Severity tiers, worst first:
  S1 score-corrupting  - the student is marked wrong for a right answer (key, malformed key, type, unsound)
  S2 unsolvable        - data / option / figure missing, identical options, wrong question
  S3 misleading        - the solution teaches a wrong step
  S4 cosmetic          - spelling, markup, exam tag, unit wording
  S5 metadata          - chapter / syllabus filing
"""
from __future__ import annotations

import math
from datetime import datetime, timezone

TIER = {
    "answer_key": 1, "type_mismatch": 1, "unsound": 1,
    "stem_data": 2, "option_repair": 2, "identical_options": 2, "diagram": 2, "wrong_question": 2,
    "solution_fix": 3, "solution_missing": 3, "notation": 3,
    "spelling": 4, "noise": 4, "exam_reference": 4, "markup_leak": 4, "answer_form": 4,
    "wrong_chapter": 5, "syllabus": 5,
}
TIER_LABEL = {1: "Marks students wrong", 2: "Can't be solved as shown", 3: "Teaches a wrong step",
              4: "Cosmetic", 5: "Filing / metadata", 9: "No defect"}
TIER_WEIGHT = {1: 100, 2: 60, 3: 35, 4: 12, 5: 6, 9: 1}
ROUTE_WEIGHT = {"faculty_review": 1.0, "auto_apply": 0.35, "no_change": 0.1}


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def score_case(issues: list[dict], reports: list[dict], now: datetime | None = None) -> dict:
    now = now or max(_parse(r["reportedAt"]) for r in reports)
    defects = [i for i in issues if i.get("verdict") == "defect" and i.get("repair")]
    tier = min((TIER.get(i["repair"], 4) for i in defects), default=9)
    route = "faculty_review" if any(i.get("route") == "faculty_review" for i in issues) else \
            "auto_apply" if any(i.get("route") == "auto_apply" for i in issues) else "no_change"
    n = len(reports)
    oldest = min(_parse(r["reportedAt"]) for r in reports)
    age_days = max(0.0, (now - oldest).total_seconds() / 86400)
    reach = 1 + math.log2(n) + min(age_days, 7) / 7  # more students and longer waits both raise it
    score = TIER_WEIGHT[tier] * reach * ROUTE_WEIGHT[route]
    bits = [TIER_LABEL[tier]]
    bits.append(f"{n} student{'s' if n != 1 else ''}")
    bits.append(f"waiting {age_days:.0f}d" if age_days >= 1 else "reported today")
    return {"score": round(score, 1), "tier": tier, "tierLabel": TIER_LABEL[tier], "route": route,
            "reason": " · ".join(bits), "oldest": oldest.isoformat().replace("+00:00", "Z"), "reports": n}
