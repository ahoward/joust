# #42 — Strategy-based scoring

**Spec:** https://github.com/ahoward/joust/issues/42
**Status:** in-progress
**Branch:** `strategy-scoring`

## Plan

Phase 1 of the epic, split into commit-sized steps. Each step ends with green tests.

1. Types + Strategy interface (`src/types.ts`, `src/strategies/index.ts`)
2. `invariants` strategy implementation (`src/strategies/invariants.ts`)
3. `rubric` strategy implementation (`src/strategies/rubric.ts`)
4. `color` strategy implementation (`src/strategies/color.ts`)
5. Rewrite `src/lint.ts` — dispatch over configured strategies, aggregate scorecards, enforce floors and color tier
6. Rewrite `src/run.ts` — best-so-far tracking, plateau detection, lexicographic comparison
7. Rewrite `src/bootstrap.ts` — write `strategies:` block into `config.json`
8. Migration shim — legacy `invariants: {MUST,SHOULD,MUST_NOT}` history entries rehydrate as single-strategy config
9. `joust status` + `joust export` + `joust plan` updates
10. `./dev/test` + `./dev/post_flight` green; dogfood smoke test

## Done

- **[step 1]** types + Strategy interface. Added fib scale, Scorecard, StrategiesConfig, Strategy<N> + registry in `src/types.ts` and `src/strategies/index.ts`. Tests: 72 pass. Commit: `11f3654`.
- **[step 2]** `invariants` strategy. `src/strategies/invariants.ts` + 9 tests. Bootstrap classifies+extracts; score marks met/not-met and maps to fib floors. Commit: `3d01093`.
- **[step 3]** `rubric` strategy. `src/strategies/rubric.ts` + 8 tests. Commit: `865e6f3`.
- **[step 4]** `color` strategy. Commit: `8ff4895`.
- **[step 5]** lint dispatcher. Commit: `99e04e5`.
- **[step 6]** rewrite `run.ts` around score_draft + compare_results. Extended `Snowball` with optional `strategies`, `best_draft`, `best_scoring`, `aggregate_history` (back-compat for legacy entries). Added `migrate_snowball` — legacy entries with `invariants` rehydrate as `strategies.invariants`, empty otherwise. Jouster + polish gates now: compute `ScoringResult` for candidate, accept iff `passed && compare_results(candidate, best) >= 0`. Best-so-far tracking via `best_draft` / `best_scoring`. Plateau detection: aggregate_history tail of K+1 with improvements ≤ ε = 0.02 ends the loop. Final STDOUT emits `best_draft`. Tests (9 new) — `is_plateau` edge cases + `migrate_snowball` three paths. `./dev/test` 114 pass. Commit: _pending_.

## Next

**Step 7 — bootstrap writes `strategies:` block.** Rewrite `src/init.ts` to run all three strategies' `bootstrap()` calls, collect the non-null results into a `StrategiesConfig`, and persist it into the initial snowball (`snowball.strategies`). Also keep the existing `result.invariants` / `result.draft` schema for the seed draft. The operator-edit surface is the snowball's `strategies` field — next run reads it. (Phase 2 will make this editable via rfc.yaml; phase 1 keeps it in the snowball.)

## Deferred

- Exemplars / acceptance / goal-constraints strategies (phase 3 of epic)
- Deterministic scorers (phase 4)
- Pairwise comparison mode (phase 2)
- `/reanchor` mid-run command (phase 2)
- Per-dim score diff in `joust diff` (phase 2)

## Pitfalls

- **Legacy history migration must come before `run.ts` tries to resume a run.** If step 8 is out of order, resume will crash on legacy entries. Order matters.
- **`color` can be configured alone.** Guard in bootstrap or lint — if `color` is the sole strategy, there's no tie-breaker past the 3 levels. Warn or auto-add `rubric`. TBD during step 4.
- **`check_context_size` in `src/utils.ts` references `snowball.invariants`.** Step 5 needs to update this too, otherwise token-budget checks break silently.
- **Retire stale `rfc.yaml` comments while touching these files.** Tracked separately in #44 but cheaper to fix inline.

## Open questions

- Should `bootstrap.ts` offer the operator a chance to review/edit `strategies:` before `/run`? Current flow auto-generates and runs. Phase 1 keep it auto; add interactive-edit as a later UX bump.
- Plateau epsilon and K — epic says ε=0.02, K=2. Hardcode these for phase 1; phase 2 makes them configurable.
