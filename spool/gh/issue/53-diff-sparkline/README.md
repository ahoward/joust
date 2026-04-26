# #53 — /diff per-dim score deltas + /status sparkline

**Spec:** https://github.com/ahoward/joust/issues/53
**Status:** ready-for-review
**Branch:** `phase-2.5-diff-sparkline`

## Plan

1. New file `src/sparkline.ts` with a single `sparkline(values)` function. Maps each value to one of 8 unicode block chars (U+2581..U+2588).
2. `commands.ts::status` calls `sparkline()` and emits below the trajectory line.
3. `commands.ts::diff` extended: when both compared entries have `best_scoring`, render a per-dim score delta block (per-strategy aggregate change, per-dim score change with rationale, color tier change).
4. Tests: sparkline edges (empty, single, all-equal, normal). Diff-with-scores integration test (synthetic snowballs).

## Done

- src/sparkline.ts: `sparkline(values: number[]): string` mapping to 8 unicode blocks. Handles empty / single / all-equal degenerates without div-by-zero.
- test/sparkline.test.ts: 7 cases covering edge cases.
- commands.ts /status: emit sparkline below the trajectory line when history has > 1 value.
- commands.ts /diff: when both entries have best_scoring, emit a `=== scores ===` block with color_tier change, weighted_aggregate change, per-strategy aggregate change, per-dim score change with ↑/↓ arrows. Legacy / pre-strategy entries fall through to text-only diff.
- 156 tests pass, binary compiles.

## Next

Nothing — ready to merge after dogfood smoke.

## Pitfalls

- For diff: if either entry is pre-strategy (no best_scoring), fall back to today's text-only diff.
- Sparkline empty / 1-value: emit `(no data)` and a single-block char respectively.
- All-equal trajectory: emit a uniform middle-block sparkline rather than divide-by-zero.
