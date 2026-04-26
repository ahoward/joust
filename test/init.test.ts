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
  test("returns empty config + 3 declined when every strategy declines", async () => {
    _reset_strategies();
    install_double("invariants", null);
    install_double("rubric", null);
    install_double("color", null);

    const out = await _bootstrap_strategies(fake_agent, "a prompt");
    expect(out.config).toEqual({});
    expect(out.declined).toHaveLength(3);
    for (const d of out.declined) {
      expect(d.rationale).toContain("classifier returned null");
    }
  });

  test("returns only strategies that returned non-null; declined are tracked", async () => {
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
    expect(out.config.invariants).toEqual({ MUST: ["a"], SHOULD: [], MUST_NOT: [] });
    expect(out.config.rubric).toBeUndefined();
    expect(out.config.color).toEqual({ question: "is this safe?" });
    expect(out.declined.map((d) => d.name)).toEqual(["rubric"]);
  });

  test("errors in one strategy's bootstrap surface as declined with the error message", async () => {
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
    expect(out.config.invariants).toBeUndefined();
    expect(out.config.rubric?.dimensions).toHaveLength(1);
    const inv = out.declined.find((d) => d.name === "invariants");
    expect(inv?.rationale).toContain("simulated");
  });
});
