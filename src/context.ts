import type { AgentConfig, Snowball } from "./types";
import type { Message } from "./ai";

// --- format invariants as text block ---

function format_invariants(snowball: Snowball): string {
  const lines: string[] = [];

  if (snowball.invariants.MUST.length > 0) {
    lines.push("MUST:");
    for (const rule of snowball.invariants.MUST) {
      lines.push(`  - ${rule}`);
    }
  }

  if (snowball.invariants.SHOULD.length > 0) {
    lines.push("SHOULD:");
    for (const rule of snowball.invariants.SHOULD) {
      lines.push(`  - ${rule}`);
    }
  }

  if (snowball.invariants.MUST_NOT.length > 0) {
    lines.push("MUST NOT:");
    for (const rule of snowball.invariants.MUST_NOT) {
      lines.push(`  - ${rule}`);
    }
  }

  return lines.join("\n");
}

// --- compile the "attention sandwich" ---
//
// top:    system prompt + invariants (anchors behavior)
// middle: critique trail as pseudo assistant/user turns (narrative > wall of text)
// bottom: current draft as final user message (recency bias)

export function compile_context(
  agent: AgentConfig,
  snowball: Snowball,
  role: "jouster" | "lint" | "bootstrap" | "polish"
): Message[] {
  const messages: Message[] = [];
  const invariant_text = format_invariants(snowball);

  // --- TOP: system message ---
  if (role === "bootstrap") {
    messages.push({
      role: "system",
      content: [
        agent.system,
        "",
        "You are bootstrapping a new architecture. The user will give you a raw prompt.",
        "Expand it into a comprehensive initial draft and extract strict RFC 2119 invariants.",
        "Output as structured JSON with `invariants` (MUST, SHOULD, MUST_NOT arrays) and `draft` (markdown string).",
      ].join("\n"),
    });
  } else if (role === "lint") {
    messages.push({
      role: "system",
      content: [
        "You are the lead architect reviewing a jouster's mutation.",
        "Check the mutated draft against the following invariants.",
        "Output structured JSON: { valid: boolean, violations: string[] }",
        "",
        "INVARIANTS:",
        invariant_text,
      ].join("\n"),
    });
  } else if (role === "polish") {
    messages.push({
      role: "system",
      content: [
        agent.system,
        "",
        "You are doing a final polish pass on the draft after all jousters have contributed.",
        "Improve clarity, fix inconsistencies, and ensure the draft is cohesive.",
        "Respect the invariants. Output structured JSON: { draft, critique }",
        "",
        "INVARIANTS:",
        invariant_text,
      ].join("\n"),
    });
  } else {
    // jouster
    messages.push({
      role: "system",
      content: [
        agent.system,
        "",
        "You are reviewing and mutating an architecture draft.",
        "You MUST respect the following invariants. If you violate them, your mutation will be rejected.",
        "",
        "INVARIANTS:",
        invariant_text,
        "",
        "Output structured JSON: { draft (full rewrite of the document), critique (what you changed and why) }",
      ].join("\n"),
    });
  }

  // --- MIDDLE: critique trail as pseudo conversation ---
  if (snowball.critique_trail.length > 0 && role !== "bootstrap") {
    for (const entry of snowball.critique_trail) {
      messages.push({
        role: "assistant",
        content: `[${entry.actor}] ${entry.action}: ${entry.notes}`,
      });
      messages.push({
        role: "user",
        content: "Acknowledged. Continue.",
      });
    }
  }

  // human directives get injected as high-priority user messages
  if (snowball.human_directives.length > 0 && role !== "bootstrap") {
    for (const directive of snowball.human_directives) {
      messages.push({
        role: "user",
        content: `HUMAN DIRECTIVE (highest priority, overrides all agents): ${directive}`,
      });
    }
  }

  // --- BOTTOM: current draft or prompt ---
  if (role === "bootstrap") {
    // the draft IS the user's raw prompt at this point
    messages.push({
      role: "user",
      content: snowball.draft,
    });
  } else if (role === "lint") {
    messages.push({
      role: "user",
      content: [
        "ORIGINAL DRAFT (before mutation):",
        "---",
        snowball.draft,
        "---",
        "",
        "MUTATED DRAFT (to validate):",
        "---",
        // the caller will replace this with the actual mutated draft
        "{{MUTATED_DRAFT}}",
        "---",
      ].join("\n"),
    });
  } else {
    messages.push({
      role: "user",
      content: [
        "Here is the CURRENT DRAFT. Provide your full rewrite:",
        "",
        "---",
        snowball.draft,
        "---",
      ].join("\n"),
    });
  }

  return messages;
}

// --- inject mutated draft into lint context ---

export function inject_lint_draft(messages: Message[], mutated_draft: string): Message[] {
  return messages.map((m) => {
    if (m.content.includes("{{MUTATED_DRAFT}}")) {
      return { ...m, content: m.content.replace("{{MUTATED_DRAFT}}", mutated_draft) };
    }
    return m;
  });
}
