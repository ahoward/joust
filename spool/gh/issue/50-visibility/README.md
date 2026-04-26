# #50 — visibility (polish-regression, strategy-declination, carryover-summon)

**Spec:** https://github.com/ahoward/joust/issues/50
**Status:** ready-for-review
**Branch:** `phase-2.3-visibility`

## Plan

Three logging additions. Independent from each other but ship together.

1. **Polish-regression log.** When `polish_is_best === false` after scoring, log per-strategy aggregate delta + color tier change + top-2 dim regressions. Today's `polish complete (... kept previous best)` line is too quiet.
2. **Strategy-declination log + snowball field.** When a strategy's `bootstrap()` returns null, capture the LLM's rationale (when available) and log it at init. Also surface in `joust /status`. Snowball gets `declined_strategies?: { name, rationale }[]`.
3. **Carryover-summon log point.** Just the log point — the actual carryover mechanism lands with #52. Adds a no-op log helper that #52 will wire up.

## Done

- `log_polish_regression(prev, curr)` in src/run.ts — emits a multi-line block when polish regresses. Per-strategy aggregate delta, color-tier change, top-2 dim drops with rationale.
- `log_summon_carryover(round, snowball)` placeholder for #52 — reads `snowball.pending_summon` and emits a one-liner. Not yet wired to a call site (waits for #52 to set the field).
- Snowball gains `declined_strategies?: { name, rationale }[]`.
- `bootstrap_strategies` return type changes to `{ config, declined }`. Both decline (null returned) and error (exception) populate `declined`. Per-name `[name] declined — <reason>` logged at init time.
- `joust /status` adds a `declined:` panel listing each declined strategy + rationale.
- test/init.test.ts updated for new return shape; 3 cases assert decline tracking covers null + error + non-decline.

## Next

Nothing — ready to merge after dogfood smoke.

## Pitfalls

- Strategy `bootstrap()` doesn't currently return a rationale even when it declines. Need to extend the return type from `T | null` to `{ config: T } | { declined: string }`. Or augment with a side-channel. Either way, every strategy file changes — bigger surface than I want here. Alternative: leave bootstraps as-is, just capture absence and label it "(no rationale captured)" until phase 2 surfaces a richer interface. **Going with this.**
- Top-2 dim regressions — pick by largest score drop (max → min sort by `prev.score - curr.score`).

## Open questions

- Should polish-regression also write a marker file (like `.needs-attention`)? My read: no — this is a soft signal. Polish regression is normal; it shouldn't trigger operator interrupt.
