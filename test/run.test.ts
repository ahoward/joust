import { describe, test, expect } from "bun:test";
import { _is_plateau, _migrate_snowball } from "../src/run.ts";
import type { Snowball } from "../src/types.ts";

describe("is_plateau", () => {
  test("too few points to decide", () => {
    expect(_is_plateau([])).toBe(false);
    expect(_is_plateau([0.5])).toBe(false);
    expect(_is_plateau([0.5, 0.6])).toBe(false);
  });

  test("flat 3 = plateau (K=2)", () => {
    expect(_is_plateau([0.5, 0.5, 0.5])).toBe(true);
  });

  test("still improving > epsilon breaks plateau", () => {
    expect(_is_plateau([0.5, 0.6, 0.7])).toBe(false);
  });

  test("tiny improvement within epsilon counts as plateau", () => {
    // epsilon is 0.02 — a move of 0.01 across the window is plateau
    expect(_is_plateau([0.8, 0.81, 0.81])).toBe(true);
  });

  test("regression counts as plateau (no improvement)", () => {
    expect(_is_plateau([0.8, 0.7, 0.6])).toBe(true);
  });

  test("looks at the TAIL K+1, not the whole history", () => {
    // earlier improvement doesn't save a flat tail
    expect(_is_plateau([0.1, 0.5, 0.9, 0.9, 0.9])).toBe(true);
  });
});

describe("migrate_snowball", () => {
  const base: Snowball = {
    invariants: { MUST: [], SHOULD: [], MUST_NOT: [] },
    draft: "hello",
    critique_trail: [],
    resolved_decisions: [],
    human_directives: [],
  };

  test("already-migrated snowball passes through unchanged", () => {
    const migrated: Snowball = {
      ...base,
      strategies: { rubric: { dimensions: [{ name: "x", weight: 1, max: 13 }] } },
      best_draft: "hello",
      aggregate_history: [0.5],
    };
    expect(_migrate_snowball(migrated)).toBe(migrated);
  });

  test("legacy with no rules -> empty strategies + best_draft=current", () => {
    const out = _migrate_snowball(base);
    expect(out.strategies).toEqual({});
    expect(out.best_draft).toBe("hello");
    expect(out.aggregate_history).toEqual([]);
  });

  test("legacy with MUST rules -> invariants strategy seeded", () => {
    const snow: Snowball = {
      ...base,
      invariants: {
        MUST: ["a"],
        SHOULD: ["b"],
        MUST_NOT: ["c"],
      },
    };
    const out = _migrate_snowball(snow);
    expect(out.strategies?.invariants).toEqual({
      MUST: ["a"],
      SHOULD: ["b"],
      MUST_NOT: ["c"],
    });
    expect(out.best_draft).toBe("hello");
  });
});
