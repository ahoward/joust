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

- **[step 1]** types + Strategy interface. Added `FIB_SCALE`, `FibScore`, `DimensionScore`, `Scorecard`, `ScoringResult`, and `StrategiesConfig` (with sub-schemas for `rubric`, `invariants`, `color`) to `src/types.ts`. Created `src/strategies/index.ts` with the `Strategy<N>` interface + per-strategy registry. Added `test/strategies.test.ts` (16 cases — fib-scale validation, scorecard shape, config shape, registry semantics). No behavior change; `./dev/test` 72 pass. Commit: _pending this commit_. Verified: `./dev/test` green.

## Next

**Step 2 — invariants strategy.** Implement `src/strategies/invariants.ts`. Bootstrap: call main with the prompt, extract `MUST/SHOULD/MUST_NOT` (same structured-output pattern as current `BootstrapResultSchema`). Score: each MUST/MUST_NOT → `{ max:13, floor:13 }`; each SHOULD → `{ max:13, no floor }`. `register_strategy()` on import. Unit tests with a fake agent stub so the test runs offline.

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
