import { describe, test, expect } from "bun:test";
import {
  create_invariants_strategy,
  _build_scorecard,
} from "../src/strategies/invariants.ts";
import type { AgentConfig, InvariantsConfig, Snowball } from "../src/types.ts";

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

describe("invariants bootstrap", () => {
  test("returns null when classifier says !applies", async () => {
    const strategy = create_invariants_strategy({
      bootstrap_call: async () => ({
        applies: false,
        MUST: [],
        SHOULD: [],
        MUST_NOT: [],
      }),
    });
    const cfg = await strategy.bootstrap({
      prompt: "polish this copy please",
      main: fake_agent,
    });
    expect(cfg).toBeNull();
  });

  test("returns null if applies=true but all arrays empty", async () => {
    const strategy = create_invariants_strategy({
      bootstrap_call: async () => ({
        applies: true,
        MUST: [],
        SHOULD: [],
        MUST_NOT: [],
      }),
    });
    const cfg = await strategy.bootstrap({
      prompt: "a spec that has no actual requirements",
      main: fake_agent,
    });
    expect(cfg).toBeNull();
  });

  test("returns a normalized InvariantsConfig when rules present", async () => {
    const strategy = create_invariants_strategy({
      bootstrap_call: async () => ({
        applies: true,
        MUST: ["atomic writes"],
        SHOULD: ["prefer existing utils"],
        MUST_NOT: ["add new deps"],
      }),
    });
    const cfg = await strategy.bootstrap({
      prompt: "write an RFC for the storage layer",
      main: fake_agent,
    });
    expect(cfg).toEqual({
      MUST: ["atomic writes"],
      SHOULD: ["prefer existing utils"],
      MUST_NOT: ["add new deps"],
    });
  });
});

describe("invariants score", () => {
  const cfg: InvariantsConfig = {
    MUST: ["atomic writes", "no secrets in logs"],
    SHOULD: ["prefer existing utils"],
    MUST_NOT: ["add new deps"],
  };

  test("all met -> aggregate 1.0, no floor violations", async () => {
    const strategy = create_invariants_strategy({
      score_call: async () => ({
        scores: [
          { rule: "atomic writes", kind: "MUST", met: true, rationale: "see line 10" },
          { rule: "no secrets in logs", kind: "MUST", met: true, rationale: "ok" },
          { rule: "prefer existing utils", kind: "SHOULD", met: true, rationale: "ok" },
          { rule: "add new deps", kind: "MUST_NOT", met: true, rationale: "no new deps introduced" },
        ],
      }),
    });
    const card = await strategy.score(cfg, {
      main: fake_agent,
      snowball: empty_snowball,
      candidate_draft: "any",
    });
    expect(card.strategy).toBe("invariants");
    expect(card.dimensions).toHaveLength(4);
    expect(card.aggregate).toBe(1.0);
    for (const d of card.dimensions) {
      expect(d.score).toBe(13);
    }
  });

  test("MUST violated -> score 0 with floor=13 (caller detects violation)", async () => {
    const strategy = create_invariants_strategy({
      score_call: async () => ({
        scores: [
          { rule: "atomic writes", kind: "MUST", met: false, rationale: "uses fs.writeFile without rename" },
          { rule: "no secrets in logs", kind: "MUST", met: true, rationale: "ok" },
          { rule: "prefer existing utils", kind: "SHOULD", met: true, rationale: "ok" },
          { rule: "add new deps", kind: "MUST_NOT", met: true, rationale: "ok" },
        ],
      }),
    });
    const card = await strategy.score(cfg, {
      main: fake_agent,
      snowball: empty_snowball,
      candidate_draft: "any",
    });
    const violated = card.dimensions.find((d) => d.name.startsWith("MUST: atomic writes"))!;
    expect(violated.score).toBe(0);
    expect(violated.floor).toBe(13);
    // aggregate: 3 of 4 dims scored 13, one scored 0 → 3/4 = 0.75
    expect(card.aggregate).toBeCloseTo(0.75, 5);
  });

  test("SHOULD violated has no floor — soft signal only", async () => {
    const strategy = create_invariants_strategy({
      score_call: async () => ({
        scores: [
          { rule: "atomic writes", kind: "MUST", met: true, rationale: "ok" },
          { rule: "no secrets in logs", kind: "MUST", met: true, rationale: "ok" },
          { rule: "prefer existing utils", kind: "SHOULD", met: false, rationale: "introduced a local util" },
          { rule: "add new deps", kind: "MUST_NOT", met: true, rationale: "ok" },
        ],
      }),
    });
    const card = await strategy.score(cfg, {
      main: fake_agent,
      snowball: empty_snowball,
      candidate_draft: "any",
    });
    const should_dim = card.dimensions.find((d) => d.name.startsWith("SHOULD:"))!;
    expect(should_dim.score).toBe(0);
    expect(should_dim.floor).toBeUndefined();
  });

  test("MUST_NOT violated -> score 0 with floor=13", async () => {
    const strategy = create_invariants_strategy({
      score_call: async () => ({
        scores: [
          { rule: "atomic writes", kind: "MUST", met: true, rationale: "ok" },
          { rule: "no secrets in logs", kind: "MUST", met: true, rationale: "ok" },
          { rule: "prefer existing utils", kind: "SHOULD", met: true, rationale: "ok" },
          { rule: "add new deps", kind: "MUST_NOT", met: false, rationale: "added 'foo' package" },
        ],
      }),
    });
    const card = await strategy.score(cfg, {
      main: fake_agent,
      snowball: empty_snowball,
      candidate_draft: "any",
    });
    const mn = card.dimensions.find((d) => d.name.startsWith("MUST_NOT:"))!;
    expect(mn.score).toBe(0);
    expect(mn.floor).toBe(13);
  });

  test("missing score for a rule -> score 0 with fallback rationale", async () => {
    const strategy = create_invariants_strategy({
      score_call: async () => ({
        scores: [
          // only one score returned, others missing
          { rule: "atomic writes", kind: "MUST", met: true, rationale: "ok" },
        ],
      }),
    });
    const card = await strategy.score(cfg, {
      main: fake_agent,
      snowball: empty_snowball,
      candidate_draft: "any",
    });
    const missing = card.dimensions.find((d) => d.name.startsWith("SHOULD:"))!;
    expect(missing.score).toBe(0);
    expect(missing.rationale).toContain("no score returned");
  });
});

describe("_build_scorecard", () => {
  test("empty config -> aggregate 1.0", () => {
    const card = _build_scorecard(
      { MUST: [], SHOULD: [], MUST_NOT: [] },
      { scores: [] }
    );
    expect(card.aggregate).toBe(1);
    expect(card.dimensions).toHaveLength(0);
  });
});
