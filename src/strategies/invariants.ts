// invariants strategy — RFC 2119-style MUST / SHOULD / MUST_NOT rules.
//
// bootstrap: extract explicit requirements from the prompt (don't invent).
// score: each MUST/MUST_NOT becomes a dim with floor=13 (hard fail if
// violated). each SHOULD becomes a dim without a floor (soft signal).
// all dims live on the fib scale.

import { z } from "zod";
import { call_agent_structured, type Message } from "../ai";
import {
  InvariantsConfigSchema,
  type InvariantsConfig,
  type Scorecard,
  FIB_SCALE,
} from "../types";
import {
  register_strategy,
  type BootstrapContext,
  type ScoreContext,
  type Strategy,
} from "./index";

// --- bootstrap schema (what the LLM returns) ---

const InvariantsBootstrapSchema = z.object({
  applies: z.boolean().describe(
    "true if the prompt contains explicit MUST/SHOULD/MUST_NOT requirements or is a spec/RFC/contract. false for pure polish or open-ended quality prompts."
  ),
  MUST: z.array(z.string()).default([]).describe(
    "hard requirements — things the output MUST do. Extract from the prompt; do not invent."
  ),
  SHOULD: z.array(z.string()).default([]).describe(
    "soft requirements — things the output SHOULD do if possible."
  ),
  MUST_NOT: z.array(z.string()).default([]).describe(
    "anti-requirements — things the output MUST NOT do."
  ),
});

// --- scoring schema (what the LLM returns for each item) ---

const InvariantScoreSchema = z.object({
  rule: z.string().describe("the rule text being scored, verbatim from the config"),
  kind: z.enum(["MUST", "SHOULD", "MUST_NOT"]),
  met: z.boolean().describe(
    "for MUST/SHOULD: true if the draft satisfies the rule. for MUST_NOT: true if the draft avoids the thing."
  ),
  rationale: z.string().describe("one sentence citing evidence from the draft"),
});

const InvariantsScoringSchema = z.object({
  scores: z.array(InvariantScoreSchema),
});

// --- agent-call shims (swappable in tests) ---
//
// production path: call the real main agent via call_agent_structured.
// tests override these to return canned responses with no network.

export type BootstrapFn = (
  messages: Message[],
  signal?: AbortSignal
) => Promise<z.infer<typeof InvariantsBootstrapSchema>>;

export type ScoreFn = (
  messages: Message[],
  signal?: AbortSignal
) => Promise<z.infer<typeof InvariantsScoringSchema>>;

// --- bootstrap ---

async function default_bootstrap_call(
  ctx: BootstrapContext
): ReturnType<BootstrapFn> {
  const messages: Message[] = [
    {
      role: "system",
      content: [
        "You are classifying whether a user's prompt calls for explicit RFC-style invariants (MUST / SHOULD / MUST_NOT).",
        "",
        "Invariants apply when the prompt contains explicit requirements, a contract, a spec, an RFC, acceptance criteria, or compliance asks.",
        "Invariants do NOT apply to pure polish, review, comparison, or open-ended quality prompts — those use the rubric strategy instead.",
        "",
        "If invariants apply, extract the MUST / SHOULD / MUST_NOT statements from the prompt verbatim. Do not invent requirements the prompt does not state.",
        "",
        "If invariants do not apply, return applies=false and empty arrays.",
      ].join("\n"),
    },
    { role: "user", content: ctx.prompt },
  ];
  return await call_agent_structured(
    ctx.main,
    messages,
    InvariantsBootstrapSchema,
    {
      signal: ctx.signal,
      tools: ctx.tools,
      max_tool_steps: ctx.max_tool_steps,
      log_dir: ctx.log_dir,
      log_label: ctx.log_label ?? "invariants:bootstrap",
    }
  );
}

async function bootstrap_invariants(
  ctx: BootstrapContext,
  override?: BootstrapFn
): Promise<InvariantsConfig | null> {
  const raw = override
    ? await override(
        [{ role: "user", content: ctx.prompt }],
        ctx.signal
      )
    : await default_bootstrap_call(ctx);
  if (!raw.applies) return null;
  const total = raw.MUST.length + raw.SHOULD.length + raw.MUST_NOT.length;
  if (total === 0) return null;
  return InvariantsConfigSchema.parse({
    MUST: raw.MUST,
    SHOULD: raw.SHOULD,
    MUST_NOT: raw.MUST_NOT,
  });
}

// --- scoring ---

function format_config(cfg: InvariantsConfig): string {
  const lines: string[] = [];
  if (cfg.MUST.length) {
    lines.push("MUST:");
    for (const r of cfg.MUST) lines.push(`  - ${r}`);
  }
  if (cfg.SHOULD.length) {
    lines.push("SHOULD:");
    for (const r of cfg.SHOULD) lines.push(`  - ${r}`);
  }
  if (cfg.MUST_NOT.length) {
    lines.push("MUST NOT:");
    for (const r of cfg.MUST_NOT) lines.push(`  - ${r}`);
  }
  return lines.join("\n");
}

async function default_score_call(
  cfg: InvariantsConfig,
  ctx: ScoreContext
): ReturnType<ScoreFn> {
  const messages: Message[] = [
    {
      role: "system",
      content: [
        "You are the lint agent. Judge whether the candidate draft satisfies each invariant below.",
        "",
        "For each MUST: set met=true iff the draft clearly satisfies it. Be strict — if in doubt, met=false.",
        "For each SHOULD: set met=true if the draft satisfies the rule or has an acceptable justification for not doing so.",
        "For each MUST_NOT: set met=true iff the draft clearly avoids doing the thing.",
        "",
        "Provide a single-sentence rationale citing evidence from the draft for each score.",
        "",
        "INVARIANTS:",
        format_config(cfg),
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "CANDIDATE DRAFT:",
        "---",
        ctx.candidate_draft,
        "---",
      ].join("\n"),
    },
  ];
  return await call_agent_structured(
    ctx.main,
    messages,
    InvariantsScoringSchema,
    {
      signal: ctx.signal,
      tools: ctx.tools,
      max_tool_steps: ctx.max_tool_steps,
      log_dir: ctx.log_dir,
      log_label: ctx.log_label ?? "invariants:score",
    }
  );
}

// map each rule+result to a dim on the fib scale.
//   MUST:     met -> 13, else -> 0; floor=13
//   MUST_NOT: met -> 13, else -> 0; floor=13
//   SHOULD:   met -> 13, else -> 0; no floor
// this is phase-1 "boolean-in-fib-shape" — a future strategy could score
// SHOULD on a continuous fib scale; for now we match today's behavior.
function build_scorecard(
  cfg: InvariantsConfig,
  raw: z.infer<typeof InvariantsScoringSchema>
): Scorecard {
  const by_key = new Map<string, z.infer<typeof InvariantScoreSchema>>();
  for (const s of raw.scores) {
    by_key.set(`${s.kind}:${s.rule}`, s);
  }

  const dimensions = [];
  const FLOOR = 13;
  const MAX_FIB = FIB_SCALE[FIB_SCALE.length - 1]!; // 13

  const emit = (kind: "MUST" | "SHOULD" | "MUST_NOT", rule: string) => {
    const hit = by_key.get(`${kind}:${rule}`);
    const met = hit?.met ?? false;
    const rationale = hit?.rationale ?? `(no score returned for ${kind}: ${rule})`;
    const score = met ? MAX_FIB : 0;
    const floor = kind === "SHOULD" ? undefined : FLOOR;
    dimensions.push({
      name: `${kind}: ${rule}`,
      score,
      max: MAX_FIB,
      weight: 1,
      floor,
      rationale,
    });
  };

  for (const rule of cfg.MUST) emit("MUST", rule);
  for (const rule of cfg.SHOULD) emit("SHOULD", rule);
  for (const rule of cfg.MUST_NOT) emit("MUST_NOT", rule);

  // aggregate: normalized weighted mean. each dim contributes score/max,
  // weighted uniformly in phase 1.
  let sum = 0;
  let wsum = 0;
  for (const d of dimensions) {
    const norm = d.score / d.max;
    sum += norm * d.weight;
    wsum += d.weight;
  }
  const aggregate = wsum > 0 ? sum / wsum : 1;

  return {
    strategy: "invariants",
    dimensions,
    aggregate,
  };
}

async function score_invariants(
  cfg: InvariantsConfig,
  ctx: ScoreContext,
  override?: ScoreFn
): Promise<Scorecard> {
  const raw = override
    ? await override(
        [{ role: "user", content: ctx.candidate_draft }],
        ctx.signal
      )
    : await default_score_call(cfg, ctx);
  return build_scorecard(cfg, raw);
}

// --- public Strategy instance ---
//
// we export factory + pre-built instance. the factory lets tests
// inject fake agent-call functions; the pre-built instance is what
// gets registered for production use.

export function create_invariants_strategy(overrides?: {
  bootstrap_call?: BootstrapFn;
  score_call?: ScoreFn;
}): Strategy<"invariants"> {
  return {
    name: "invariants",
    bootstrap: (ctx) => bootstrap_invariants(ctx, overrides?.bootstrap_call),
    score: (cfg, ctx) => score_invariants(cfg, ctx, overrides?.score_call),
  };
}

export const invariants_strategy = create_invariants_strategy();

register_strategy(invariants_strategy);

// expose the internal builder for tests
export const _build_scorecard = build_scorecard;
