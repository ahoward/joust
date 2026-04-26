// sparkline — render a numeric series as a row of unicode block chars.
// used by `joust /status` to show the aggregate-history trajectory at a
// glance (#53).
//
// 8 levels: U+2581 (▁ lowest) through U+2588 (█ full). values are
// linearly mapped between the series min and max. degenerate cases:
//   - empty series          → ""
//   - single value          → single mid-bar
//   - all values equal      → all mid-bars (no gradient to show)

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return BLOCKS[3]!; // mid

  let min = values[0]!;
  let max = values[0]!;
  for (let i = 1; i < values.length; i++) {
    const v = values[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const range = max - min;
  if (range === 0) {
    // uniform — render at the mid level
    return BLOCKS[3]!.repeat(values.length);
  }

  const out: string[] = [];
  for (const v of values) {
    const norm = (v - min) / range;
    const idx = Math.min(BLOCKS.length - 1, Math.max(0, Math.round(norm * (BLOCKS.length - 1))));
    out.push(BLOCKS[idx]!);
  }
  return out.join("");
}
