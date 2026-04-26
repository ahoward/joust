# #52 — score specialists + pending_summon carryover

**Spec:** https://github.com/ahoward/joust/issues/52
**Status:** ready-for-review
**Branch:** `phase-2.2-score-specialists`

## Plan

1. Add `pending_summon` field to `Snowball`. Optional. Carries `{ specialist, ask, summoned_by, attempts, last_rejection? }` across rounds.
2. Extract specialist invocation from inside the jouster loop into a helper function `invoke_specialist(name, ask, summoned_by, attempts, last_rejection?)` that can be called from two sites: initial summon (in jouster turn) and round-start carryover.
3. Inside the helper: lint → if invalid, return rejected outcome; if valid, score_candidate → if floor/no-improvement, return rejected; otherwise accept.
4. Caller decides what to do with the outcome:
   - Accept: clear pending_summon (or never set it). Update best_draft if scoring improved.
   - Reject: set/update pending_summon with attempts++ and last_rejection.
   - Cap exhausted (attempts >= max_retries): clear pending_summon, log loudly (.needs-attention marker).
5. At round start, if `pending_summon` is set and not exhausted, invoke before any jouster.
6. The existing `MAX_SUMMONS_PER_ROUND` cap must accommodate the carryover — carryover invocations don't count against it (they're re-runs of an already-counted summon).
7. Wire the existing `log_summon_carryover()` helper from #50 to fire at round start.

## Done

- types.ts: Snowball gains optional `pending_summon: { specialist, ask, summoned_by, attempts, last_rejection? }`.
- run.ts: extracted `invoke_specialist()` helper plus `SpecialistContext` type; helper handles agent build, optional last_rejection retry feedback, lint gate, score gate (when strategies configured), accept/reject branches with their respective history entries. Returns a structured `SpecialistOutcome`.
- run.ts: added round-start carryover. If `snowball.pending_summon` is set and `attempts < max_retries`, run `invoke_specialist` before any jouster. Carryovers don't consume `summons_this_round` cap. On accept: clear pending_summon. On reject: increment attempts, store last_rejection. On exhaustion: clear pending_summon, write `.needs-attention` marker, log loudly, run continues.
- run.ts: inline jouster summon block replaced with `invoke_specialist` call. New summon doesn't fire if pending_summon is already set (deferred with a warning log).
- log_summon_carryover wired to fire at round start.
- 1 new test for migrate_snowball preserving pending_summon. 149 tests pass total.

## Next

Nothing — ready to merge after dogfood smoke.

## Pitfalls

- The current code sets `MAX_SUMMONS_PER_ROUND = 1`. With carryover, that's the right cap *for new summons*, but a carryover doesn't increment summons_this_round. Need to be precise.
- Specialist scoring noise: cheap-scorer × specialist gating is the hazard Gemini flagged in roadmap r3. Mitigation: invariants strategy floor violations bypass scorer noise (those are deterministic-ish at the LLM level — most rejections are MUST violations, which the strategy reliably catches at temp=0). Live scorer noise is a phase-3 concern.
- Specialist mutation that accepts but regresses score: same as a jouster — best_draft only advances when scoring improved.
- A new mutation by the next jouster after a specialist runs *replaces* the specialist's draft. That's correct — specialists contribute one mutation each turn; if it doesn't survive the next jouster's mutation, that's normal evolution.

## Open questions

- If `pending_summon.specialist` was for `legal` and the next round's first jouster *also* summons (a different specialist, e.g. `security`), do we run both? **Decision:** yes, in order: carryover first (it's older), then new summon (subject to MAX_SUMMONS_PER_ROUND, which carryovers don't consume).

## Deferred

- Per-specialist max_attempts override (some specialists may warrant more retries than others). Phase-3 polish.
