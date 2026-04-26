# #51 — cheap-model scorer override

**Spec:** https://github.com/ahoward/joust/issues/51
**Status:** ready-for-review
**Branch:** `phase-2.1-cheap-scorer`

## Plan

1. `JoustDefaults` gains optional `scorer_model: string`.
2. `generate_default_config` emits it commented-out.
3. New helper `build_scorer_agent(main, scorer_model)` in src/config.ts — clones main with `model` overridden. Returns main as-is when scorer_model is unset.
4. In `src/run.ts`, build the scorer agent once per round (config can reload), pass it into `score_candidate` as a separate arg.
5. `score_candidate` threads scorer agent into `score_draft(scorer, ...)` — note that `score_draft` already takes `main: AgentConfig`, just give it the cheaper agent.
6. Bootstrap stays on real main (separate code path in init.ts).
7. `joust /plan` mentions scorer model in output.
8. Tests: scorer_model defaults to main when null; non-null applies; build_scorer_agent unit tests.

## Done

- types.ts: `JoustDefaults` gains optional `scorer_model`.
- config.ts: emits `scorer_model` commented-out in `generate_default_config`. New `build_scorer_agent(main, scorer_model?)` clones main with model swapped (api_key, system, temperature inherit). Returns main as-is when scorer_model is unset or matches main.
- run.ts: `scorer = build_scorer_agent(main, config.defaults.scorer_model)` once per round (so config edits between rounds take effect). Passed to `score_candidate(scorer, ...)` for both jouster and polish gates. Bootstrap stays on real main (separate code path in init.ts).
- score_candidate's first arg renamed `main → scorer` for clarity.
- commands.ts /plan: when scorer_model differs, plan output shows it on its own line with a "noisier; unset for final run" note. Cost breakdown splits main (lint+polish) from scorer (strategy scoring) so two-model setups show their share.
- 3 new tests (test/config.test.ts) for build_scorer_agent: unset returns main, equal-model returns main, different-model returns clone with model swapped and main unmutated.
- 148 tests pass, binary compiles.

## Next

Nothing — ready to merge after dogfood smoke.

## Pitfalls

- If user sets `scorer_model: "claude-haiku-4-5"` but their config doesn't define an agent that uses haiku's API key, we need to handle the API key resolution. **Decision:** scorer_model uses main's API key. The model string is the only override. Document this in the README. Multi-provider scorers (e.g., main=Claude, scorer=Gemini) are a phase-3 concern.

## Open questions

- Should scorer_model also override `temperature`? Probably no — temp=0 is desired for scorers regardless.

## Deferred to follow-on issues

- **Floor-violation pre-check.** I'd planned to implement deterministic substring matching for MUST_NOT before paying for an LLM call. But: most rules are semantic ("MUST be atomic", "MUST NOT introduce new deps"), not literal. Per-rule discipline is needed. Tracking as a future issue if the noise turns out to be a real problem.
- **Tiebreaker re-run with main agent on N consecutive cheap-scorer rejections.** Lower priority; ship cheap scorer and observe.
