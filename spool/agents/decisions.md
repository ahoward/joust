# agent decisions

Flat, dated log of key decisions. Newest at top. One entry per decision.

Format:
```
## YYYY-MM-DD — <headline> (#<issue>)

<One paragraph on the reasoning: what was considered, what was rejected, what made this the right answer.>
```

---

## 2026-04-24 — fast-forward `main` from `joust-self-improve`, restart strategy-scoring

Long-lived divergence discovered: `main` was at v0.1.0 (`b034242`) while `joust-self-improve` had 17 unmerged commits containing all the real runtime work — tool use (`src/tools.ts`), two-peer panel, specialist summoning, P0-P3 hardening, provider cache, workspace config, etc. My strategy-scoring branch had been cut from old `main` and missed all of it. Chose to fast-forward `main` to `joust-self-improve` (clean ancestor relationship, no merge commits needed), close PRs #36 (superseded) and #46 (wrong base), delete `joust-self-improve` and the old `strategy-scoring` branch, and restart #42 on the corrected `main`. Saved strategy modules + tests to `/tmp/strategy-salvage/` for transplant — they're runtime-agnostic. Integration work (run.ts/init.ts/lint.ts) gets redone against the real runtime so it composes with tool use + specialists instead of deleting them.

## 2026-04-23 — adopt spool convention for multi-session work (#45)

Work on large epics was repeatedly stalling across context resets: decisions re-litigated, partial work undone. Spool gives every multi-session piece of work a live working dir, a promotion path into long-lived specs, and an archive on close. Canonical spec: https://github.com/ahoward/spool.

## 2026-04-23 — strategies replace single-anchor lint (#42)

`MUST / SHOULD / MUST_NOT` is a single-lens, binary anchor. Most drafts need multiple lenses at once (invariants *and* rubric) and a qualitative gradient (so the loop can climb). Rewriting lint to dispatch over a configurable set of strategies, each producing a scorecard on the fibonacci scale. Phase 1 ships `rubric`, `invariants`, `color`.

## 2026-04-23 — fibonacci scale, not linear (#42)

LLM scorers cluster in the middle with linear 1–5 scales. Fibonacci (0, 1, 2, 3, 5, 8, 13) forces real judgment between levels — a gap from 5 to 8 is noticeable, where 3 to 4 wouldn't be. Boolean floor semantics preserved via per-dim `floor` (a MUST is `max: 13, floor: 13, score: 0 or 13`).

## 2026-04-23 — lexicographic comparison when color is configured (#42)

Color (red/yellow/green) has only 3 levels — can't drive monotonic aggregate improvement on its own. Solution: compare drafts lexicographically by `(color_tier, weighted_aggregate)`. Color has veto (red fails) and promotion (green beats yellow); within a tier, aggregate decides. Preserves the "more iterations improve" property.

## 2026-04-23 — bootstrap writes strategies config, no classifier module (#42)

Earlier drafts had a `classify()` function emitting a weighted mix with confidence scores. Rejected: an operator wants to *see* and *edit* what strategies apply, not inspect a function return value. Bootstrap extends its current job to also write a `strategies:` block into `config.json`. Operator edits to change. No flags, no classifier service.
