import { describe, test, expect } from "bun:test";
import {
  create_color_strategy,
  _build_scorecard,
} from "../src/strategies/color.ts";
import type { AgentConfig, ColorConfig, Snowball } from "../src/types.ts";

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

describe("color bootstrap", () => {
  test("null when !applies", async () => {
    const strategy = create_color_strategy({
      bootstrap_call: async () => ({ applies: false, question: "" }),
    });
    const cfg = await strategy.bootstrap({
      prompt: "write a poem",
      main: fake_agent,
    });
    expect(cfg).toBeNull();
  });

  test("null when applies=true but question empty", async () => {
    const strategy = create_color_strategy({
      bootstrap_call: async () => ({ applies: true, question: "   " }),
    });
    const cfg = await strategy.bootstrap({
      prompt: "check safety",
      main: fake_agent,
    });
    expect(cfg).toBeNull();
  });

  test("normalized ColorConfig when applies", async () => {
    const strategy = create_color_strategy({
      bootstrap_call: async () => ({
        applies: true,
        question: "is this safe for a general audience?",
      }),
    });
    const cfg = await strategy.bootstrap({
      prompt: "moderate this text",
      main: fake_agent,
    });
    expect(cfg).toEqual({ question: "is this safe for a general audience?" });
  });
});

describe("color score", () => {
  const cfg: ColorConfig = { question: "is this safe?" };

  test("green -> aggregate 1.0, color_tier green, no violation", async () => {
    const strategy = create_color_strategy({
      score_call: async () => ({ answer: "green", rationale: "safe" }),
    });
    const card = await strategy.score(cfg, {
      main: fake_agent,
      snowball: empty_snowball,
      candidate_draft: "hi",
    });
    expect(card.aggregate).toBe(1);
    expect(card.color_tier).toBe("green");
    expect(card.dimensions[0]!.score).toBe(2);
    expect(card.dimensions[0]!.floor).toBe(1);
  });

  test("yellow -> aggregate 0.5, color_tier yellow, at floor (no violation)", async () => {
    const strategy = create_color_strategy({
      score_call: async () => ({ answer: "yellow", rationale: "unclear" }),
    });
    const card = await strategy.score(cfg, {
      main: fake_agent,
      snowball: empty_snowball,
      candidate_draft: "x",
    });
    expect(card.aggregate).toBe(0.5);
    expect(card.color_tier).toBe("yellow");
    expect(card.dimensions[0]!.score).toBe(1);
    // yellow == floor, so at the line — caller compares score < floor for violation
    expect(card.dimensions[0]!.score).toBeGreaterThanOrEqual(card.dimensions[0]!.floor!);
  });

  test("red -> aggregate 0, color_tier red, floor violation", async () => {
    const strategy = create_color_strategy({
      score_call: async () => ({ answer: "red", rationale: "bad" }),
    });
    const card = await strategy.score(cfg, {
      main: fake_agent,
      snowball: empty_snowball,
      candidate_draft: "x",
    });
    expect(card.aggregate).toBe(0);
    expect(card.color_tier).toBe("red");
    expect(card.dimensions[0]!.score).toBe(0);
    expect(card.dimensions[0]!.score).toBeLessThan(card.dimensions[0]!.floor!);
  });
});
