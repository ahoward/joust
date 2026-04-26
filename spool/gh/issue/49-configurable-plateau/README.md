# #49 — configurable plateau parameters

**Spec:** https://github.com/ahoward/joust/issues/49
**Status:** ready-for-review
**Branch:** `phase-2.4-configurable-plateau`

## Plan

Single-commit change. Tests + small migration of constants → config.

1. `src/types.ts`: add `plateau_epsilon` and `plateau_k` to `JoustDefaults`.
2. `src/config.ts`: include them in `generate_default_config` output.
3. `src/run.ts`: read from config, drop the `PLATEAU_EPSILON` / `PLATEAU_K` constants. Pass them into `is_plateau`.
4. `test/run.test.ts`: pass values into `is_plateau` (function signature changes).
5. Run `./dev/test`, `bun build`, smoke test.

## Done

- types.ts: `JoustDefaults` gains `plateau_epsilon` and `plateau_k` (both optional with `?`).
- config.ts: `DEFAULT_DEFAULTS` includes them; `generate_default_config` emits them in the JSON.
- run.ts: read into `plateau_epsilon` / `plateau_k` locals at run start; threaded through `is_plateau(history, epsilon, k)`. Constants renamed to `DEFAULT_*` and used as fallback.
- test/run.test.ts: existing cases pass `E, K` literals. 3 new cases for custom epsilon/k.
- 145 tests pass (was 142). Binary compiles.

## Next

Nothing — ready to merge after review + dogfood smoke.

## Pitfalls

- Existing snowballs / configs do not have these fields. `resolve_config` should default-fill so we don't break older runs.
- `is_plateau` currently takes only `history: number[]`. Signature changes to `is_plateau(history, epsilon, k)`. Callers must thread through.

## Open questions

- None.
