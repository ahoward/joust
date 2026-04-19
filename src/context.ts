import { log } from "./utils";
import type { AgentConfig, AgentRole, Snowball } from "./types";
import type { Message } from "./ai";

// --- token estimation ---
// rough heuristic: ~4 chars per token for English text

export function estimate_tokens(messages: Message[]): number {
  const total_chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(total_chars / 4);
}

// known context window sizes (input tokens)
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
  "gemini-2.5-pro": 1_000_000,
  "gpt-4o": 128_000,
  "gpt-4-turbo": 128_000,
  "o1": 200_000,
};

export function check_context_size(model: string, messages: Message[]): void {
  const est = estimate_tokens(messages);
  // find matching limit — prefix match for model families
  let limit = 200_000; // safe default
  for (const [prefix, ctx] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (model.startsWith(prefix)) { limit = ctx; break; }
  }
  const threshold = limit * 0.85; // warn at 85% capacity
  if (est > threshold) {
    log(`[warn] estimated ${est} tokens (~${Math.round(est / limit * 100)}% of ${model} context window). Consider compaction.`);
  }
}

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
// middle: critique trail as batched context (token-efficient)
// bottom: current draft as final user message (recency bias)

export function compile_context(
  agent: AgentConfig,
  snowball: Snowball,
  role: AgentRole,
  options?: { mutated_draft?: string; has_tools?: boolean }
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
    const polish_lines = [
      agent.system,
      "",
      "You are doing a final polish pass on the draft after all jousters have contributed.",
      "Improve clarity, fix inconsistencies, and ensure the draft is cohesive.",
      "Respect the invariants. Output structured JSON: { draft, critique }",
      "",
      "INVARIANTS:",
      invariant_text,
    ];
    if (options?.has_tools) {
      polish_lines.push(
        "",
        "You have tools to read files from the project workspace. Use them to verify",
        "claims in the draft against actual code.",
      );
    }
    messages.push({ role: "system", content: polish_lines.join("\n") });
  } else if (role === "compact") {
    messages.push({
      role: "system",
      content: [
        agent.system,
        "",
        "You are compacting the critique trail into a dense summary of resolved decisions.",
        "Preserve every decision, rationale, and trade-off — compress the text, not the information.",
        "Output structured JSON: { summary: string }",
      ].join("\n"),
    });
  } else if (role === "ask") {
    const ask_lines = [
      agent.system,
      "",
      "You are answering a question about an architecture draft.",
      "You have access to the full draft, invariants, and critique history below.",
      "Answer the user's question directly. Be specific — cite details from the draft.",
      "",
      "INVARIANTS:",
      invariant_text,
    ];
    if (options?.has_tools) {
      ask_lines.push(
        "",
        "You have tools to read files from the project workspace. Use them to ground your answers",
        "in actual code. Do not guess at file contents — read them.",
      );
    }
    messages.push({ role: "system", content: ask_lines.join("\n") });
  } else {
    // jouster
    const jouster_lines = [
      agent.system,
      "",
      "You are reviewing and mutating an architecture draft.",
      "You MUST respect the following invariants. If you violate them, your mutation will be rejected.",
      "",
      "INVARIANTS:",
      invariant_text,
      "",
    ];
    if (options?.has_tools) {
      jouster_lines.push(
        "You have tools to read files from the project workspace. Use them to ground your analysis",
        "in actual code. Do not guess at file contents — read them. Cite specific files and line numbers.",
        "",
      );
    }
    jouster_lines.push(
      "Output structured JSON: { draft (full rewrite of the document), critique (what you changed and why) }",
    );
    messages.push({ role: "system", content: jouster_lines.join("\n") });
  }

  // --- MIDDLE: critique trail as batched context ---
  if (snowball.critique_trail.length > 0 && role !== "bootstrap") {
    const trail_text = snowball.critique_trail
      .map((e) => `[${e.actor}] ${e.action}: ${e.notes}`)
      .join("\n\n");
    messages.push({
      role: "user",
      content: `Previous review history:\n\n${trail_text}`,
    });
    messages.push({
      role: "assistant",
      content: "Understood. I have reviewed the full critique trail above.",
    });
  }

  // resolved decisions from prior compactions
  if (snowball.resolved_decisions.length > 0 && role !== "bootstrap") {
    messages.push({
      role: "user",
      content: `Resolved decisions from prior rounds:\n\n${snowball.resolved_decisions.join("\n\n")}`,
    });
    messages.push({
      role: "assistant",
      content: "Understood. I have reviewed the resolved decisions above.",
    });
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
    messages.push({
      role: "user",
      content: snowball.draft,
    });
  } else if (role === "lint") {
    if (!options?.mutated_draft) {
      throw new Error("compile_context for 'lint' role requires options.mutated_draft");
    }
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
        options.mutated_draft,
        "---",
      ].join("\n"),
    });
  } else if (role === "compact") {
    messages.push({
      role: "user",
      content: [
        "Compact the critique trail above into a dense summary.",
        "The current draft for reference:",
        "---",
        snowball.draft,
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
