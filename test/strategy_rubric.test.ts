import { describe, test, expect } from "bun:test";
import {
  create_rubric_strategy,
  _build_scorecard,
} from "../src/strategies/rubric.ts";
import type { AgentConfig, RubricConfig, Snowball } from "../src/types.ts";

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

describe("rubric bootstrap", () => {
  test("returns null when classifier says !applies", async () => {
    const strategy = create_rubric_strategy({
      bootstrap_call: async () => ({ applies: false, dimensions: [] }),
    });
    const cfg = await strategy.bootstrap({
      prompt: "strict compliance check",
      main: fake_agent,
    });
    expect(cfg).toBeNull();
  });

  test("returns null if applies=true but no dimensions", async () => {
    const strategy = create_rubric_strategy({
      bootstrap_call: async () => ({ applies: true, dimensions: [] }),
    });
    const cfg = await strategy.bootstrap({
      prompt: "x",
      main: fake_agent,
    });
    expect(cfg).toBeNull();
  });

  test("returns normalized RubricConfig", async () => {
    const strategy = create_rubric_strategy({
      bootstrap_call: async () => ({
        applies: true,
        dimensions: [
          { name: "clarity", description: "how clear the prose is", weight: 2 },
          { name: "security", description: "resistance to injection", weight: 3 },
          { name: "humor", description: "whether it's funny", weight: 1 },
        ],
      }),
    });
    const cfg = await strategy.bootstrap({
      prompt: "write a funny, secure login page",
      main: fake_agent,
    });
    expect(cfg).not.toBeNull();
    expect(cfg!.dimensions).toHaveLength(3);
    expect(cfg!.dimensions[0]!.name).toBe("clarity");
    expect(cfg!.dimensions[0]!.weight).toBe(2);
    expect(cfg!.dimensions[0]!.max).toBe(13);
  });
});

describe("rubric score", () => {
  const cfg: RubricConfig = {
    dimensions: [
      { name: "clarity", weight: 2, max: 13 },
      { name: "security", weight: 3, max: 13 },
      { name: "humor", weight: 1, max: 13 },
    ],
  };

  test("all perfect -> aggregate 1.0", async () => {
    const strategy = create_rubric_strategy({
      score_call: async () => ({
        scores: [
          { name: "clarity", score: 13, rationale: "crisp" },
          { name: "security", score: 13, rationale: "sound" },
          { name: "humor", score: 13, rationale: "funny" },
        ],
      }),
    });
    const card = await strategy.score(cfg, {
      main: fake_agent,
      snowball: empty_snowball,
      candidate_draft: "any",
    });
    expect(card.strategy).toBe("rubric");
    expect(card.aggregate).toBeCloseTo(1.0, 5);
    expect(card.dimensions).toHaveLength(3);
  });

  test("weighted aggregate math is right", async () => {
    // clarity 8/13 × 2  +  security 13/13 × 3  +  humor 0/13 × 1
    // = (8/13)*2 + 1*3 + 0
    // divided by (2+3+1) = 6
    const strategy = create_rubric_strategy({
      score_call: async () => ({
        scores: [
          { name: "clarity", score: 8, rationale: "ok" },
          { name: "security", score: 13, rationale: "sound" },
          { name: "humor", score: 0, rationale: "grim" },
        ],
      }),
    });
    const card = await strategy.score(cfg, {
      main: fake_agent,
      snowball: empty_snowball,
      candidate_draft: "any",
    });
    const expected = ((8 / 13) * 2 + 1 * 3 + 0) / 6;
    expect(card.aggregate).toBeCloseTo(expected, 5);
  });

  test("missing score defaults to 0 with fallback rationale", async () => {
    const strategy = create_rubric_strategy({
      score_call: async () => ({
        scores: [
          { name: "clarity", score: 8, rationale: "ok" },
          // security + humor missing
        ],
      }),
    });
    const card = await strategy.score(cfg, {
      main: fake_agent,
      snowball: empty_snowball,
      candidate_draft: "any",
    });
    const sec = card.dimensions.find((d) => d.name === "security")!;
    expect(sec.score).toBe(0);
    expect(sec.rationale).toContain("no score returned");
  });

  test("no floors on rubric dims", async () => {
    const strategy = create_rubric_strategy({
      score_call: async () => ({
        scores: [
          { name: "clarity", score: 0, rationale: "terrible" },
          { name: "security", score: 0, rationale: "bad" },
          { name: "humor", score: 0, rationale: "grim" },
        ],
      }),
    });
    const card = await strategy.score(cfg, {
      main: fake_agent,
      snowball: empty_snowball,
      candidate_draft: "any",
    });
    for (const d of card.dimensions) {
      expect(d.floor).toBeUndefined();
    }
    expect(card.aggregate).toBe(0);
  });
});

describe("_build_scorecard", () => {
  test("empty config aggregates to 0", () => {
    const card = _build_scorecard({ dimensions: [] as any }, { scores: [] });
    expect(card.aggregate).toBe(0);
  });
});
