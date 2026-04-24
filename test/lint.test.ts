import { describe, test, expect } from "bun:test";
import { score_draft, compare_results } from "../src/lint.ts";
import { create_invariants_strategy } from "../src/strategies/invariants.ts";
import { create_rubric_strategy } from "../src/strategies/rubric.ts";
import { create_color_strategy } from "../src/strategies/color.ts";
import {
  register_strategy,
  _reset_strategies,
} from "../src/strategies/index.ts";
import type {
  AgentConfig,
  ScoringResult,
  Snowball,
  StrategiesConfig,
} from "../src/types.ts";

const fake_agent: AgentConfig = {
  name: "main",
  model: "claude-opus-4-6",
  api_key: "$FAKE",
  system: "test",
  temperature: 0.2,
};

const empty_snowball: Snowball = {
  invariants: { MUST: [], SHOULD: [], MUST_NOT: [] },
  draft: "",
  critique_trail: [],
  resolved_decisions: [],
  human_directives: [],
};

// helper: swap all three strategies for test-doubles that return canned
// answers. resets the registry so we don't leak state between tests.
function install_doubles(opts: {
  invariants_score?: any;
  rubric_score?: any;
  color_score?: any;
}) {
  _reset_strategies();
  register_strategy(
    create_invariants_strategy({
      score_call: opts.invariants_score ? async () => opts.invariants_score : undefined,
    })
  );
  register_strategy(
    create_rubric_strategy({
      score_call: opts.rubric_score ? async () => opts.rubric_score : undefined,
    })
  );
  register_strategy(
    create_color_strategy({
      score_call: opts.color_score ? async () => opts.color_score : undefined,
    })
  );
}

// restore the pristine registry after a test so later tests (which
// import the real modules) see them registered.
function restore_real_strategies() {
  // re-importing modules after a reset — we just re-create+register
  // from the same factories so production semantics are back in place.
  _reset_strategies();
  register_strategy(create_invariants_strategy());
  register_strategy(create_rubric_strategy());
  register_strategy(create_color_strategy());
}

describe("score_draft", () => {
  test("empty StrategiesConfig: passes trivially, aggregate 1.0", async () => {
    restore_real_strategies();
    const result = await score_draft(fake_agent, {}, empty_snowball, "any");
    expect(result.passed).toBe(true);
    expect(result.scorecards).toHaveLength(0);
    expect(result.weighted_aggregate).toBe(1);
    expect(result.color_tier).toBeNull();
    expect(result.floor_violations).toHaveLength(0);
  });

  test("single rubric strategy: aggregate = that rubric's aggregate", async () => {
    install_doubles({
      rubric_score: {
        scores: [
          { name: "clarity", score: 8, rationale: "ok" },
          { name: "security", score: 13, rationale: "sound" },
        ],
      },
    });
    const cfg: StrategiesConfig = {
      rubric: {
        dimensions: [
          { name: "clarity", weight: 1, max: 13 },
          { name: "security", weight: 1, max: 13 },
        ],
      },
    };
    const result = await score_draft(fake_agent, cfg, empty_snowball, "draft");
    expect(result.passed).toBe(true);
    expect(result.scorecards).toHaveLength(1);
    expect(result.weighted_aggregate).toBeCloseTo((8 / 13 + 1) / 2, 5);
  });

  test("MUST violation -> passed=false, floor_violations populated", async () => {
    install_doubles({
      invariants_score: {
        scores: [
          { rule: "atomic writes", kind: "MUST", met: false, rationale: "uses write" },
        ],
      },
    });
    const cfg: StrategiesConfig = {
      invariants: {
        MUST: ["atomic writes"],
        SHOULD: [],
        MUST_NOT: [],
      },
    };
    const result = await score_draft(fake_agent, cfg, empty_snowball, "x");
    expect(result.passed).toBe(false);
    expect(result.floor_violations).toHaveLength(1);
    expect(result.floor_violations[0]!.strategy).toBe("invariants");
    expect(result.floor_violations[0]!.score).toBe(0);
    expect(result.floor_violations[0]!.floor).toBe(13);
  });

  test("red color -> floor violation + color_tier red", async () => {
    install_doubles({
      color_score: { answer: "red", rationale: "unsafe" },
    });
    const cfg: StrategiesConfig = { color: { question: "is this safe?" } };
    const result = await score_draft(fake_agent, cfg, empty_snowball, "bad");
    expect(result.passed).toBe(false);
    expect(result.color_tier).toBe("red");
    expect(result.floor_violations).toHaveLength(1);
  });

  test("yellow color + green-passing rubric: passes, tier=yellow", async () => {
    install_doubles({
      color_score: { answer: "yellow", rationale: "uncertain" },
      rubric_score: {
        scores: [{ name: "clarity", score: 13, rationale: "great" }],
      },
    });
    const cfg: StrategiesConfig = {
      color: { question: "is this safe?" },
      rubric: { dimensions: [{ name: "clarity", weight: 1, max: 13 }] },
    };
    const result = await score_draft(fake_agent, cfg, empty_snowball, "x");
    expect(result.passed).toBe(true);
    expect(result.color_tier).toBe("yellow");
    // weighted_aggregate = mean(color_agg=0.5, rubric_agg=1.0) = 0.75
    expect(result.weighted_aggregate).toBeCloseTo(0.75, 5);
  });

  test("all three configured: aggregate is mean across three cards", async () => {
    install_doubles({
      invariants_score: {
        scores: [{ rule: "x", kind: "MUST", met: true, rationale: "ok" }],
      },
      rubric_score: {
        scores: [{ name: "clarity", score: 13, rationale: "great" }],
      },
      color_score: { answer: "green", rationale: "safe" },
    });
    const cfg: StrategiesConfig = {
      invariants: { MUST: ["x"], SHOULD: [], MUST_NOT: [] },
      rubric: { dimensions: [{ name: "clarity", weight: 1, max: 13 }] },
      color: { question: "is this safe?" },
    };
    const result = await score_draft(fake_agent, cfg, empty_snowball, "x");
    expect(result.passed).toBe(true);
    expect(result.scorecards).toHaveLength(3);
    expect(result.weighted_aggregate).toBe(1);
    expect(result.color_tier).toBe("green");
  });
});

describe("compare_results", () => {
  const make = (tier: "red" | "yellow" | "green" | null, agg: number): ScoringResult => ({
    scorecards: [],
    weighted_aggregate: agg,
    color_tier: tier,
    floor_violations: [],
    passed: true,
  });

  test("green beats yellow regardless of aggregate", () => {
    const green_low = make("green", 0.1);
    const yellow_high = make("yellow", 0.99);
    expect(compare_results(green_low, yellow_high)).toBe(1);
    expect(compare_results(yellow_high, green_low)).toBe(-1);
  });

  test("same tier: higher aggregate wins", () => {
    const a = make("yellow", 0.8);
    const b = make("yellow", 0.7);
    expect(compare_results(a, b)).toBe(1);
    expect(compare_results(b, a)).toBe(-1);
  });

  test("no color: aggregate decides", () => {
    const a = make(null, 0.9);
    const b = make(null, 0.8);
    expect(compare_results(a, b)).toBe(1);
  });

  test("equal aggregate + same tier = 0", () => {
    const a = make("green", 0.7);
    const b = make("green", 0.7);
    expect(compare_results(a, b)).toBe(0);
  });
});
