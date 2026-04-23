# #42 — Strategy-based scoring

**Spec:** https://github.com/ahoward/joust/issues/42
**Status:** ready-for-review
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
- **[step 7]** `init.ts` bootstraps strategies. Commit: `9c53f2e`.
- **[step 8]** migration + commands.ts. Commit: `01ccb4e`.
- **[step 9]** cleanup. Removed legacy `lint_mutation` (zero callers); removed `LintResultSchema`/`LintResult` type (zero remaining uses). `src/context.ts::format_invariants` now prefers `snowball.strategies.invariants` with legacy fallback — jouster/polish system prompts stay accurate through the migration window. Binary compiles + `--help` smoke-test passes. Commit: _pending this commit_.

## Next

Nothing. Phase 1 of #42 is implementation-complete. Remaining before close:
1. **Review.** User reviews the branch. May request changes.
2. **Integration.** Run `joust draft "some prompt" --workspace .` against a real agent panel to confirm end-to-end behavior (requires API keys). Cannot be automated from this session.
3. **Promotion.** On close, promote what shipped into `spool/docs/strategies.md` (new file, canonical current-truth), append dated entries to `spool/agents/decisions.md`, archive this dir to `spool/gh/issue/archive/42-strategy-scoring/`. Per spool methodology.

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
