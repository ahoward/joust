import { describe, test, expect } from "bun:test";
import { _is_plateau, _migrate_snowball } from "../src/run.ts";
import type { Snowball } from "../src/types.ts";

// default values matching the prior hardcoded constants. now configurable
// via JoustDefaults.plateau_epsilon / plateau_k (#49); these tests use the
// historical defaults to preserve existing coverage. additional cases below
// exercise non-default ε/k.
const E = 0.02;
const K = 2;

describe("is_plateau", () => {
  test("too few points to decide", () => {
    expect(_is_plateau([], E, K)).toBe(false);
    expect(_is_plateau([0.5], E, K)).toBe(false);
    expect(_is_plateau([0.5, 0.6], E, K)).toBe(false);
  });

  test("flat 3 = plateau (K=2)", () => {
    expect(_is_plateau([0.5, 0.5, 0.5], E, K)).toBe(true);
  });

  test("still improving > epsilon breaks plateau", () => {
    expect(_is_plateau([0.5, 0.6, 0.7], E, K)).toBe(false);
  });

  test("tiny improvement within epsilon counts as plateau", () => {
    // epsilon is 0.02 — a move of 0.01 across the window is plateau
    expect(_is_plateau([0.8, 0.81, 0.81], E, K)).toBe(true);
  });

  test("regression counts as plateau (no improvement)", () => {
    expect(_is_plateau([0.8, 0.7, 0.6], E, K)).toBe(true);
  });

  test("looks at the TAIL K+1, not the whole history", () => {
    // earlier improvement doesn't save a flat tail
    expect(_is_plateau([0.1, 0.5, 0.9, 0.9, 0.9], E, K)).toBe(true);
  });

  test("custom epsilon: improvement of 0.05 is plateau when ε=0.1", () => {
    expect(_is_plateau([0.6, 0.65, 0.65], 0.1, 2)).toBe(true);
  });

  test("custom epsilon: improvement of 0.05 breaks plateau when ε=0.01", () => {
    expect(_is_plateau([0.6, 0.65, 0.65], 0.01, 2)).toBe(false);
  });

  test("custom k=3: needs 4 flat points", () => {
    expect(_is_plateau([0.5, 0.5, 0.5], E, 3)).toBe(false);
    expect(_is_plateau([0.5, 0.5, 0.5, 0.5], E, 3)).toBe(true);
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

  test("round-trips a realistic legacy history entry", () => {
    // simulate reading an old history JSON that predates strategies
    const legacy_raw = {
      step: 5,
      actor: "ivy",
      action: "mutation",
      status: "accepted",
      timestamp: "2026-04-10T12:00:00Z",
      snowball: {
        invariants: {
          MUST: ["atomic writes"],
          SHOULD: ["prefer bun apis"],
          MUST_NOT: ["add node-only deps"],
        },
        draft: "# RFC: storage layer\n...",
        critique_trail: [
          {
            actor: "ivy",
            action: "mutated_draft",
            notes: "tightened error handling",
            timestamp: "2026-04-10T11:59:00Z",
          },
        ],
        resolved_decisions: [],
        human_directives: [],
      },
    };
    // parse as a Snowball (no new fields)
    const snow: Snowball = legacy_raw.snowball as any;
    // no strategies / best_draft / history originally
    expect((snow as any).strategies).toBeUndefined();
    // after migration, the entry is usable
    const migrated = _migrate_snowball(snow);
    expect(migrated.strategies?.invariants?.MUST).toEqual(["atomic writes"]);
    expect(migrated.best_draft).toBe(snow.draft);
    expect(migrated.aggregate_history).toEqual([]);
    // legacy fields preserved unchanged
    expect(migrated.draft).toBe(snow.draft);
    expect(migrated.critique_trail).toEqual(snow.critique_trail);
  });
});
