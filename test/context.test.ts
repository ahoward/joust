import { describe, test, expect } from "bun:test";
import { compile_context } from "../src/context";
import type { AgentConfig, Snowball } from "../src/types";

const mock_agent: AgentConfig = {
  name: "test",
  model: "claude-sonnet-4-6",
  api_key: "$ANTHROPIC_API_KEY",
  system: "You are a test agent.",
  temperature: 0.2,
};

const mock_snowball: Snowball = {
  invariants: {
    MUST: ["handle 100k qps"],
    SHOULD: ["prefer managed services"],
    MUST_NOT: ["introduce vendor lock-in"],
  },
  draft: "# Test Draft\n\nThis is a test.",
  critique_trail: [
    { actor: "security", action: "mutated_draft", notes: "added mTLS", timestamp: "2025-01-01T00:00:00Z" },
  ],
  resolved_decisions: [],
  human_directives: [],
};

describe("compile_context", () => {
  test("bootstrap role includes system prompt and user prompt", () => {
    const empty_snowball: Snowball = {
      invariants: { MUST: [], SHOULD: [], MUST_NOT: [] },
      draft: "design a cache",
      critique_trail: [],
      resolved_decisions: [],
      human_directives: [],
    };
    const messages = compile_context(mock_agent, empty_snowball, "bootstrap");
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("bootstrapping");
    expect(messages[messages.length - 1].content).toBe("design a cache");
  });

  test("jouster role includes invariants and current draft", () => {
    const messages = compile_context(mock_agent, mock_snowball, "jouster");
    const system_msg = messages[0].content;
    expect(system_msg).toContain("MUST:");
    expect(system_msg).toContain("handle 100k qps");
    expect(system_msg).toContain("MUST NOT:");
    const last = messages[messages.length - 1].content;
    expect(last).toContain("# Test Draft");
  });

  test("lint role requires mutated_draft option", () => {
    expect(() => compile_context(mock_agent, mock_snowball, "lint")).toThrow("requires options.mutated_draft");
  });

  test("lint role includes both original and mutated draft", () => {
    const messages = compile_context(mock_agent, mock_snowball, "lint", {
      mutated_draft: "# Mutated Draft",
    });
    const last = messages[messages.length - 1].content;
    expect(last).toContain("ORIGINAL DRAFT");
    expect(last).toContain("# Test Draft");
    expect(last).toContain("MUTATED DRAFT");
    expect(last).toContain("# Mutated Draft");
  });

  test("lint context does not contain placeholder strings", () => {
    const messages = compile_context(mock_agent, mock_snowball, "lint", {
      mutated_draft: "# Mutated Draft",
    });
    const all_content = messages.map((m) => m.content).join("\n");
    expect(all_content).not.toContain("{{MUTATED_DRAFT}}");
  });

  test("critique trail is batched into single message", () => {
    const messages = compile_context(mock_agent, mock_snowball, "jouster");
    // should have: system, trail (1 user msg), trail ack (1 assistant msg), draft
    const trail_msg = messages.find((m) => m.content.includes("Previous review history"));
    expect(trail_msg).toBeDefined();
    expect(trail_msg!.content).toContain("[security] mutated_draft: added mTLS");
  });

  test("compact role includes system prompt for compaction", () => {
    const messages = compile_context(mock_agent, mock_snowball, "compact");
    expect(messages[0].content).toContain("compacting");
  });

  test("human directives are included for non-bootstrap roles", () => {
    const s: Snowball = {
      ...mock_snowball,
      human_directives: ["focus on cost reduction"],
    };
    const messages = compile_context(mock_agent, s, "jouster");
    const directive_msg = messages.find((m) => m.content.includes("HUMAN DIRECTIVE"));
    expect(directive_msg).toBeDefined();
    expect(directive_msg!.content).toContain("focus on cost reduction");
  });

  test("resolved decisions are included", () => {
    const s: Snowball = {
      ...mock_snowball,
      resolved_decisions: ["decided to use Redis for caching"],
    };
    const messages = compile_context(mock_agent, s, "jouster");
    const decision_msg = messages.find((m) => m.content.includes("Resolved decisions"));
    expect(decision_msg).toBeDefined();
    expect(decision_msg!.content).toContain("Redis for caching");
  });
});
