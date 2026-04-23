import { describe, test, expect } from "bun:test";
import { _bootstrap_strategies } from "../src/init.ts";
import {
  register_strategy,
  _reset_strategies,
  type Strategy,
} from "../src/strategies/index.ts";
import type { AgentConfig } from "../src/types.ts";

const fake_agent: AgentConfig = {
  name: "main",
  model: "claude-opus-4-6",
  api_key: "$FAKE",
  system: "test",
  temperature: 0.2,
};

// minimal valid scorecard for test doubles
const trivial_scorecard = { strategy: "x", dimensions: [], aggregate: 0 };

// helper: install a single test-double strategy
function install_double<N extends "rubric" | "invariants" | "color">(
  name: N,
  bootstrap_returns: any
): void {
  const s: Strategy<N> = {
    name,
    bootstrap: async () => bootstrap_returns,
    score: async () => ({ ...trivial_scorecard, strategy: name }),
  };
  register_strategy(s);
}

describe("bootstrap_strategies", () => {
  test("returns {} when every strategy declines", async () => {
    _reset_strategies();
    install_double("invariants", null);
    install_double("rubric", null);
    install_double("color", null);

    const out = await _bootstrap_strategies(fake_agent, "a prompt");
    expect(out).toEqual({});
  });

  test("returns only strategies that returned non-null", async () => {
    _reset_strategies();
    install_double("invariants", {
      MUST: ["a"],
      SHOULD: [],
      MUST_NOT: [],
    });
    install_double("rubric", null);
    install_double("color", {
      question: "is this safe?",
    });

    const out = await _bootstrap_strategies(fake_agent, "spec + safety check");
    expect(out.invariants).toEqual({ MUST: ["a"], SHOULD: [], MUST_NOT: [] });
    expect(out.rubric).toBeUndefined();
    expect(out.color).toEqual({ question: "is this safe?" });
  });

  test("errors in one strategy's bootstrap don't take down the others", async () => {
    _reset_strategies();
    register_strategy({
      name: "invariants",
      bootstrap: async () => { throw new Error("simulated"); },
      score: async () => ({ ...trivial_scorecard, strategy: "invariants" }),
    });
    install_double("rubric", {
      dimensions: [{ name: "clarity", weight: 1, max: 13 }],
    });
    install_double("color", null);

    const out = await _bootstrap_strategies(fake_agent, "prompt");
    expect(out.invariants).toBeUndefined();
    expect(out.rubric?.dimensions).toHaveLength(1);
  });
});
