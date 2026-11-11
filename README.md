# Report → Fix: Acadza error-report triage

A student taps **Report error** and types *"ans galat hai"*. This system works out what is actually true, writes the smallest safe fix, applies it only when it can prove it, and hands everything else to faculty in a console built for a tired person at 10 PM.

- **Live console:** https://acadza-fix-desk.onrender.com (loads precomputed engine output; no LLM calls from the browser)
- **Scored output:** [`results.json`](results.json) (44 reports)
- **Defects nobody reported (bonus):** [`findings.json`](findings.json), also in the console's *Nobody reported* tab
- **Docs:** [`PROMPTS.md`](PROMPTS.md) (prompts, failures, decisions) · [`PRODUCT.md`](PRODUCT.md) (one page)

## Results at a glance

| | |
|---|---|
| Reports triaged | **44** (39 questions, 4 more audited proactively) |
| Routes | **21** auto-applied · **6** to faculty · **17** no change |
| Unsafe auto-applies vs. my hand labels | **0** |
| Agreement with my hand labels (verdict / repair / route) | 43 / 44 each. The one difference (R034) is a case where I now think the engine is arguably right ([PROMPTS.md §3](PROMPTS.md#3-three-moments-the-ai-was-wrong-and-how-i-caught-it)) |
| Defects nobody reported | **39** findings in [`findings.json`](findings.json): spelling, stray `&` in MathML, wrong units like `/AC`, a solution calling insulin and glucagon "synergistic", units inside square roots, a solution stopping at 0.08 m when the question asks for cm … |

> **Declared:** the free Gemini quota ran out partway through. 32 model calls were answered by Gemini and 104 by my coding assistant (Claude Opus 5.5) standing in for it, through the engine's `--manual` mode. Same prompts, same guards, every answer tagged `answeredBy` in the cache. Because that assistant had seen my hand labels, the agreement score is not an independent measurement for those groups. Details: [PROMPTS.md §2](PROMPTS.md#2-prompts-i-gave-my-ai-coding-assistant). `python -m engine run --regemini` re-asks Gemini for exactly those calls.

---

## How a report becomes a fix

```
reports.json ──► group by question (44 reports → 39 cases; duplicates are investigated once)
                    │
                    ▼
  1. LINT (deterministic, free)       missing/blank/identical options, malformed key, raw LaTeX,
                                      stray '&' in MathML, exam tags, "as shown in figure" with no image,
                                      solution-vs-key mismatch, edits made after the report, injection text
                    │
                    ▼
  2. BLIND SOLVE (LLM #1)             sees the question only: no key, no solution, no comment
     SECOND BLIND SOLVE (LLM #2)      a *different model*, run only when #1 disagrees with the key
                    │                 or lint smells a key problem (cost-aware)
                    ▼
  3. INVESTIGATOR (LLM #3)            everything above + raw HTML + comments as untrusted data
                                      → verdict, repair, surgical {field, find, replace}, evidence
                    │  ◄── if an edit doesn't apply, it gets the exact error back and retries once
                    ▼
  4. GUARDS (deterministic)           scope (field ∈ repair.fields) · find matches exactly once ·
                                      repair-specific invariants (spelling changes letters only, stem_data
                                      value must appear in the solution, answer_key needs BOTH blind solves,
                                      option repairs can't create a 2nd correct answer, …) · confidence ≥ 0.85
                    │
                    ▼
  5. ROUTE                            auto_apply only if taxonomy says auto AND every guard passes;
                                      auto:false repairs → faculty_review (suggestion only, never written);
                                      "no error" that the blind solve disputes → faculty_review
                    │
                    ▼
  6. REPLY (LLM #4, cheapest model)   written from the FINAL decision, in the student's language,
                                      post-checked: ≤3 sentences, never says "fixed" unless it was
```

**Why this shape.** The LLM is good at reading messy HTML and judging intent, and bad at being trusted with writes. So the model proposes, and plain code decides what is allowed to touch the database. The solver is blind so it can't anchor on the key or on the student's claim. That is how R004 works: the key *is* wrong, but the student's "8225" is wrong too, and the true answer is 4800. A second, different model guards against one model's blind spots on the highest-stakes repair. Details and rejected alternatives are in [PROMPTS.md §4](PROMPTS.md#4-design-decisions-log).

## The console

`web/` is a dependency-free static app: ES modules, no build step, native MathML. It reads `web/data/cases.json`, which the engine writes.

- **Queue by urgency**: *Needs you* (human-only decisions, worst harm first), *Auto-fixed* (spot-check, one-click revert), *No change* (confirm the reply), *Done*, *Nobody reported*.
  Urgency = severity tier × reach (reports, wait time) × "only a human can stop it". Wrong keys first: they take marks from students *right now*.
- **Every case answers three questions in order**: what changes (before → after, letter-level highlights, math rendered), why (the evidence sentence, every safety check ✓/✕, both blind solves with their working), and what the student will read (the reply, editable).
- **One-key actions**: `A` approve / keep / confirm, `E` edit, `R` reject / revert / reopen, `J`/`K` to move. It auto-advances, and you can undo for 6 seconds. Every action is an append-only audit entry (who, when, AI verdict + confidence, final edit, note), exportable as JSON.
- Dark mode, keyboard-first, works on a phone, student comments are always rendered as text, and production HTML is sanitised (inline colours stripped so dark mode works).

> The hosted console reads **precomputed** engine output and does not call an LLM. Decisions and the audit log are stored in your browser (localStorage). That way the demo needs no backend or keys and stays up for free. `web/lib/store.js` is the only module that would change for a real backend.

## Run it

```bash
pip install -r requirements.txt
python -m pytest -q                     # guards + lint, no LLM needed
python -m engine run --replay           # rebuild results.json + console data from the committed LLM cache (no key)
python -m engine eval                   # score results.json against my hand labels (eval/expected.json)
python -m http.server 8765 --directory web   # open http://localhost:8765
```

With a key (free tier is enough): put `GEMINI_API_KEY=...` in `.env`, then `python -m engine run`. The cache is used first, so only new or changed prompts cost anything. `--refresh` re-asks everything, and `--only R004` runs one report. When the free quota is exhausted, there are two more modes. `--manual` writes the remaining prompts to `engine/pending/` for a declared stand-in to answer, and `python -m engine answer` stores those answers. `--regemini` later swaps every stand-in answer back to Gemini.

**Cost:** ₹0, since everything ran on the Gemini free tier. One full run is about 135 model calls (counted from the cache); on paid Flash pricing that is a few rupees per run. The second solver only runs when needed, and replies use the cheapest model.

## Deploy (static, free)

- **Vercel:** import the repo. `vercel.json` already sets the output to `web/` with no build.
- **Render (live):** static site, publish directory `web`, no build step. GitHub Pages or any static host works the same way.
- **CI:** `.github/workflows/ci.yml` runs the tests on every push, re-runs the engine in `--replay` mode, and fails if `results.json` is not exactly reproducible.
- **Netlify:** `netlify.toml` publishes `web/`.

## Layout

```
engine/        load.py (HTML+MathML → text) · lint.py · llm.py (Gemini + cache) · prompts.py (every prompt)
               guards.py (safety layer) · priority.py (urgency) · pipeline.py · __main__.py (CLI)
engine/cache/  every model response, with the prompt that produced it
eval/          expected.json - my hand labels for all 44 reports, written before the first run
tests/         guard and lint tests on the real records
web/           the console (index.html, app.js, styles.css, lib/)
data/          the brief's data, unmodified
```
