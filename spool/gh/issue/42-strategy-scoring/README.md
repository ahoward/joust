# #42 — Strategy-based scoring

**Spec:** https://github.com/ahoward/joust/issues/42
**Status:** in-progress (restart after branch base correction)
**Branch:** `strategy-scoring`

## Context

First pass (PR #46) was built on an outdated `main`. The real state of
joust — tool use, specialist summoning, P0-P3 hardening, two-peer
panel — lived on `joust-self-improve`, which has now been fast-forwarded
into `main`. Rebasing PR #46 would have been a hand-merge of 9 commits
against massive runtime changes. Cleaner path: restart on the new main,
transplant the standalone strategy modules (they're runtime-agnostic),
redo the integration work against the real runtime.

What transplants cleanly from the old branch (saved at `/tmp/strategy-salvage/`):
- `src/strategies/{index,invariants,rubric,color}.ts` (four modules)
- `test/strategies.test.ts`, `test/strategy_{invariants,rubric,color}.test.ts`
- The strategy-scoring types in `src/types.ts` (Scorecard, StrategiesConfig, etc.)
- The `score_draft` / `compare_results` logic from the old `src/lint.ts`
- The plateau + best-so-far logic from the old `src/run.ts`

What needs real integration work (not transplant):
- `src/run.ts` — new main has specialist summoning, summon cap, peer pick, workspace tools, max_tool_steps. Strategy-scoring has to fit alongside, not replace.
- `src/init.ts` — new main uses `create_workspace_tools` at bootstrap, takes `preset`, writes `config.json` (not `rfc.yaml`). Strategy bootstraps run after main's expansion, with the same workspace tools.
- `src/lint.ts` — new main threads `tools`/`max_tool_steps`/`log_dir` into lint. Strategy scoring needs the same plumbing.
- `src/commands.ts` — new main's `status`/`export` don't know about strategies yet.
- `src/context.ts` — new main has `has_tools` across every role.

## Plan

1. Types + Strategy interface (add to `src/types.ts`, create `src/strategies/index.ts`)
2. `invariants` strategy (transplant + re-verify against current main's `call_agent_structured` signature)
3. `rubric` strategy
4. `color` strategy
5. `score_draft` + `compare_results` added to `src/lint.ts` (alongside existing `lint_mutation`, threaded with tools)
6. `src/run.ts` — wire `score_draft` into jouster + polish gates alongside existing lint; best-so-far tracking; plateau detection
7. `src/init.ts` — run strategy bootstraps after main's expansion, persist to snowball
8. Migration shim (legacy history entries → strategies config on load) + status/export/plan updates in `src/commands.ts`
9. Smoke: `./dev/test` + `./dev/post_flight` green; binary compiles

## Done

- **[step 1]** types + Strategy interface. Transplanted `FIB_SCALE`, `FibScore`, `DimensionScore`, `Scorecard`, `ScoringResult`, `Violation`, and `StrategiesConfig` (with sub-schemas) to `src/types.ts`. Created `src/strategies/index.ts` with `Strategy<N>` interface + per-strategy registry. Transplanted `test/strategies.test.ts` (16 cases). Comment updated to say `config.json` not `rfc.yaml`. No behavior change; `./dev/test` 96 pass (was 80). Commit: _pending_.

## Next

**Step 2 — `invariants` strategy.** Transplant `src/strategies/invariants.ts` + tests. The module's `default_bootstrap_call` and `default_score_call` functions use `call_agent_structured(agent, messages, schema, { signal })` — still valid on the new main (extra optional fields tolerated). Verify tests pass.

## Deferred

- Exemplars / acceptance / goal-constraints strategies (phase 3 of epic)
- Deterministic scorers (phase 4)
- Pairwise comparison mode (phase 2)
- `/reanchor` mid-run command (phase 2)
- Per-dim score diff in `joust diff` (phase 2)

## Pitfalls (from the failed first pass)

- **Project config file is `config.json`**, not `rfc.yaml`. The new main made this switch (see `src/init.ts:134`). Old spool drafts had this wrong both ways at different times.
- **`lint_mutation` stays.** Don't delete it. The new `run.ts` uses it at the polish gate for invariants-check. Strategy scoring is an *additional* gate, not a replacement. Once the loop runs both, evaluate whether to drop the legacy lint.
- **Don't break specialist summoning.** Mutations now include an optional `summon` field; specialists run as a second pass within a jouster's turn. Strategy scoring runs on the mutation itself, before the summon is executed.
- **Workspace tools are load-bearing.** Every agent call takes `tools`, `max_tool_steps`, `log_dir`. Strategy score/bootstrap calls must plumb the same args or agents will hallucinate against file paths.
- **`call_agent_structured` signature changed on new main.** It now accepts `{ tools, max_tool_steps, log_dir, log_label }` in options. The salvaged strategy modules assume the older signature — will need re-verification.
- **Test ordering + strategy registry.** `_reset_strategies()` in tests clears the registry. Subsequent test files relying on auto-register may see an empty registry because modules are cached. Currently tests pass but this is order-dependent.

## Open questions

- Does strategy scoring replace `lint_mutation` immediately, or run alongside it during phase 1? Lean: alongside, so existing invariants-based lint keeps working for runs that haven't bootstrapped strategies. Drop legacy once bootstraps produce strategies for every run.
- Do specialists get scored? Their mutation goes through the same accept/reject gate as a jouster mutation. Likely yes. Deferred to step 6.
