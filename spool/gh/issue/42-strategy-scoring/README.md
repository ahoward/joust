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
- **[step 6]** `run.ts` rewrite. Commit: `a84fbeb`.
- **[step 7]** `init.ts` bootstraps strategies. `bootstrap_strategies(main, prompt)` runs every registered strategy's `bootstrap()` in parallel, collects the non-null results into a `StrategiesConfig`, and persists it into `snowball.strategies`. Errors in one strategy's bootstrap don't kill the others (per-strategy try/catch + null on failure). The seed snowball now carries `strategies`, `best_draft`, `aggregate_history` from the start. Init log reports which strategies applied. Tests (3 new) — all-decline returns empty, mixed results filter correctly, error-resilience. `./dev/test` 117 pass. Commit: _pending_.

## Next

**Step 8 — migration + `check_context_size` fix.** `migrate_snowball` in run.ts already handles legacy entries on load. Add: `src/context.ts` `check_context_size` currently references `snowball.invariants.MUST.length` in its warning — it's actually NOT broken (token estimation is unchanged), so this step is smaller than I thought. Also — `src/commands.ts` (status/plan/export/diff) references `snowball.invariants`. Update status/plan to show strategies instead. Verify migration round-trip test with a legacy JSON fixture. Final smoke: `./dev/post_flight` green.

## Deferred

- Exemplars / acceptance / goal-constraints strategies (phase 3 of epic)
- Deterministic scorers (phase 4)
- Pairwise comparison mode (phase 2)
- `/reanchor` mid-run command (phase 2)
- Per-dim score diff in `joust diff` (phase 2)

## Pitfalls

- **Config file is `rfc.yaml` (YAML), not `config.json`.** See `spool/agents/guardrails.md`. #44 was closed as invalid.
- **Test ordering + strategy registry.** `_reset_strategies()` in `lint.test.ts` and `init.test.ts` clears the registry. Subsequent test files relying on auto-register may see an empty registry because modules are cached. Currently tests pass but this is order-dependent. If a new test fails mysteriously, consider adding a `beforeEach` that re-imports or re-registers.
- **`color` can be configured alone.** Bootstrap may emit `color`-only configs for prompts like "is this X?". Within-tier improvements can't be measured when color is alone. Consider: if bootstrap returns color-only, also force rubric. Deferred for phase 2.
- **`Snowball.invariants` is still required by schema.** Kept for back-compat during migration. When `strategies.invariants` is set, both are effectively the same data. Future cleanup: drop the top-level field once migration path is retired (not in phase 1).

## Open questions

- Should `bootstrap.ts` offer the operator a chance to review/edit `strategies:` before `/run`? Current flow auto-generates and runs. Phase 1 keep it auto; add interactive-edit as a later UX bump.
- Plateau epsilon and K — epic says ε=0.02, K=2. Hardcode these for phase 1; phase 2 makes them configurable.
