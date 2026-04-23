import { describe, test, expect, beforeEach } from "bun:test";
import {
  register_strategy,
  get_strategy,
  list_strategies,
  _reset_strategies,
  type Strategy,
} from "../src/strategies/index.ts";
import {
  FIB_SCALE,
  ScorecardSchema,
  StrategiesConfigSchema,
  DimensionScoreSchema,
  FibScoreSchema,
} from "../src/types.ts";

describe("fib scale", () => {
  test("is exactly the expected seven values", () => {
    expect(FIB_SCALE).toEqual([0, 1, 2, 3, 5, 8, 13]);
  });

  test("FibScoreSchema accepts valid scores", () => {
    for (const v of FIB_SCALE) {
      expect(FibScoreSchema.parse(v)).toBe(v);
    }
  });

  test("FibScoreSchema rejects non-fib integers", () => {
    expect(() => FibScoreSchema.parse(4)).toThrow();
    expect(() => FibScoreSchema.parse(7)).toThrow();
    expect(() => FibScoreSchema.parse(-1)).toThrow();
    expect(() => FibScoreSchema.parse(14)).toThrow();
  });
});

describe("DimensionScoreSchema", () => {
  test("parses a minimal valid dim", () => {
    const parsed = DimensionScoreSchema.parse({
      name: "clarity",
      score: 8,
      max: 13,
      rationale: "reads well",
    });
    expect(parsed.score).toBe(8);
    expect(parsed.weight).toBe(1); // default
    expect(parsed.floor).toBeUndefined();
  });

  test("honors explicit weight + floor", () => {
    const parsed = DimensionScoreSchema.parse({
      name: "security",
      score: 13,
      max: 13,
      weight: 3,
      floor: 13,
      rationale: "meets MUST",
    });
    expect(parsed.weight).toBe(3);
    expect(parsed.floor).toBe(13);
  });
});

describe("ScorecardSchema", () => {
  test("parses a passing invariants scorecard", () => {
    const card = ScorecardSchema.parse({
      strategy: "invariants",
      dimensions: [
        { name: "MUST: atomic writes", score: 13, max: 13, floor: 13, rationale: "yes" },
      ],
      aggregate: 1.0,
    });
    expect(card.strategy).toBe("invariants");
    expect(card.dimensions).toHaveLength(1);
  });

  test("accepts optional color_tier", () => {
    const card = ScorecardSchema.parse({
      strategy: "color",
      dimensions: [
        { name: "safety", score: 13, max: 13, rationale: "safe" },
      ],
      aggregate: 1.0,
      color_tier: "green",
    });
    expect(card.color_tier).toBe("green");
  });

  test("rejects aggregate > 1", () => {
    expect(() =>
      ScorecardSchema.parse({
        strategy: "rubric",
        dimensions: [],
        aggregate: 1.5,
      })
    ).toThrow();
  });
});

describe("StrategiesConfigSchema", () => {
  test("every strategy is optional", () => {
    expect(StrategiesConfigSchema.parse({})).toEqual({});
  });

  test("invariants block fills empty arrays by default", () => {
    const parsed = StrategiesConfigSchema.parse({ invariants: {} });
    expect(parsed.invariants).toEqual({ MUST: [], SHOULD: [], MUST_NOT: [] });
  });

  test("rubric requires at least one dimension", () => {
    expect(() =>
      StrategiesConfigSchema.parse({ rubric: { dimensions: [] } })
    ).toThrow();
  });

  test("color requires a non-empty question", () => {
    expect(() =>
      StrategiesConfigSchema.parse({ color: { question: "" } })
    ).toThrow();
  });

  test("full config round-trips", () => {
    const input = {
      rubric: {
        dimensions: [
          { name: "clarity", weight: 2, max: 13 },
          { name: "security", weight: 3, max: 13 },
        ],
      },
      invariants: {
        MUST: ["atomic writes"],
        SHOULD: ["prefer existing utils"],
        MUST_NOT: ["add new deps"],
      },
      color: {
        question: "is this safe?",
      },
    };
    const parsed = StrategiesConfigSchema.parse(input);
    expect(parsed).toEqual(input);
  });
});

describe("strategy registry", () => {
  beforeEach(() => {
    _reset_strategies();
  });

  test("register + get returns the same strategy", () => {
    const fake: Strategy<"rubric"> = {
      name: "rubric",
      bootstrap: async () => null,
      score: async () => ({
        strategy: "rubric",
        dimensions: [],
        aggregate: 0,
      }),
    };
    register_strategy(fake);
    expect(get_strategy("rubric")).toBe(fake);
  });

  test("get_strategy throws on unregistered name", () => {
    expect(() => get_strategy("rubric")).toThrow(/not registered/);
  });

  test("list_strategies reflects registrations", () => {
    expect(list_strategies()).toEqual([]);
    register_strategy({
      name: "color",
      bootstrap: async () => null,
      score: async () => ({ strategy: "color", dimensions: [], aggregate: 0 }),
    });
    expect(list_strategies()).toEqual(["color"]);
  });
});
