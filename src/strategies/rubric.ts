// rubric strategy — subjective dimensions scored on the fib scale.
//
// bootstrap: LLM proposes 4-8 dimensions tailored to the prompt
//   (e.g. clarity, security, completeness). Each dim gets a weight.
// score: LLM rates each dim on the fib scale with rationale.
// aggregate: normalized weighted mean across dims. no floors.
//
// applies to nearly everything — polish, quality, review, comparison,
// even specs (as a companion to invariants). returns null only when the
// prompt is pure compliance with no qualitative aspect.

import { z } from "zod";
import { call_agent_structured, type Message } from "../ai";
import {
  RubricConfigSchema,
  FIB_SCALE,
  FibScoreSchema,
  type RubricConfig,
  type Scorecard,
} from "../types";
import {
  register_strategy,
  type BootstrapContext,
  type ScoreContext,
  type Strategy,
} from "./index";

// --- bootstrap schema ---

const RubricBootstrapSchema = z.object({
  applies: z.boolean().describe(
    "true if the prompt has any qualitative aspect (quality, polish, review, comparison, design). false ONLY when the prompt is pure compliance with no subjective aspect."
  ),
  dimensions: z
    .array(
      z.object({
        name: z
          .string()
          .describe("one short lowercase name, like 'clarity' or 'security'. no spaces preferred."),
        description: z.string().describe("one sentence on what this dim measures, written so a scorer can judge it"),
        weight: z.number().int().min(1).max(5).default(1).describe("relative importance 1-5. most dims are 1; only boost the ones that really matter."),
      })
    )
    .default([])
    .describe("4-8 dims tailored to the prompt. fewer = sharper judgment; more = finer resolution."),
});

// --- score schema ---

const RubricDimScoreSchema = z.object({
  name: z.string(),
  score: FibScoreSchema,
  rationale: z.string().describe("one or two sentences on why this score, citing the draft"),
});

const RubricScoringSchema = z.object({
  scores: z.array(RubricDimScoreSchema),
});

// --- agent-call shims ---

export type BootstrapFn = (
  messages: Message[],
  signal?: AbortSignal
) => Promise<z.infer<typeof RubricBootstrapSchema>>;

export type ScoreFn = (
  messages: Message[],
  signal?: AbortSignal
) => Promise<z.infer<typeof RubricScoringSchema>>;

// --- bootstrap ---

async function default_bootstrap_call(
  ctx: BootstrapContext
): ReturnType<BootstrapFn> {
  const messages: Message[] = [
    {
      role: "system",
      content: [
        "You are designing a scoring rubric for the user's prompt.",
        "",
        "A rubric applies when the output can be judged qualitatively — on clarity, quality, completeness, accuracy, tone, security, etc. Nearly every prompt qualifies.",
        "",
        "A rubric does NOT apply ONLY when the prompt is a pure boolean compliance check with no qualitative aspect at all.",
        "",
        "If it applies, propose 4-8 dimensions tailored to this specific prompt. Pick dims that actually matter here — do not use the same generic list for every prompt. Give each a short lowercase name, a one-sentence description, and a weight 1-5 (default 1; only boost the ones that are load-bearing for this prompt).",
      ].join("\n"),
    },
    { role: "user", content: ctx.prompt },
  ];
  return await call_agent_structured(
    ctx.main,
    messages,
    RubricBootstrapSchema,
    { signal: ctx.signal }
  );
}

async function bootstrap_rubric(
  ctx: BootstrapContext,
  override?: BootstrapFn
): Promise<RubricConfig | null> {
  const raw = override
    ? await override(
        [{ role: "user", content: ctx.prompt }],
        ctx.signal
      )
    : await default_bootstrap_call(ctx);
  if (!raw.applies) return null;
  if (raw.dimensions.length === 0) return null;
  return RubricConfigSchema.parse({
    dimensions: raw.dimensions.map((d) => ({
      name: d.name,
      description: d.description,
      weight: d.weight,
      max: 13,
    })),
  });
}

// --- scoring ---

function format_rubric(cfg: RubricConfig): string {
  return cfg.dimensions
    .map((d) => {
      const desc = d.description ? `: ${d.description}` : "";
      return `  - ${d.name} (weight ${d.weight})${desc}`;
    })
    .join("\n");
}

async function default_score_call(
  cfg: RubricConfig,
  ctx: ScoreContext
): ReturnType<ScoreFn> {
  const scale_desc = FIB_SCALE.join(", ");
  const messages: Message[] = [
    {
      role: "system",
      content: [
        "You are scoring a draft against a rubric.",
        "",
        `Scores use the fibonacci scale: ${scale_desc}.`,
        "0 = absent / not attempted.",
        "1 = barely present, serious problems.",
        "2 = partial, significant gaps.",
        "3 = acceptable but rough.",
        "5 = solid.",
        "8 = very good.",
        "13 = excellent / as good as it gets for this dimension.",
        "",
        "Be decisive. Linear 1-5 clustering is forbidden — use the gaps the fib scale provides.",
        "For every dim, output a score and a one-or-two-sentence rationale citing the draft.",
        "",
        "DIMENSIONS:",
        format_rubric(cfg),
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
    RubricScoringSchema,
    { signal: ctx.signal }
  );
}

function build_scorecard(
  cfg: RubricConfig,
  raw: z.infer<typeof RubricScoringSchema>
): Scorecard {
  const by_name = new Map<string, z.infer<typeof RubricDimScoreSchema>>();
  for (const s of raw.scores) by_name.set(s.name, s);

  const dimensions = cfg.dimensions.map((d) => {
    const hit = by_name.get(d.name);
    return {
      name: d.name,
      score: hit?.score ?? 0,
      max: d.max,
      weight: d.weight,
      rationale: hit?.rationale ?? `(no score returned for ${d.name})`,
    };
  });

  let sum = 0;
  let wsum = 0;
  for (const d of dimensions) {
    const norm = d.score / d.max;
    sum += norm * d.weight;
    wsum += d.weight;
  }
  const aggregate = wsum > 0 ? sum / wsum : 0;

  return {
    strategy: "rubric",
    dimensions,
    aggregate,
  };
}

async function score_rubric(
  cfg: RubricConfig,
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

// --- public Strategy ---

export function create_rubric_strategy(overrides?: {
  bootstrap_call?: BootstrapFn;
  score_call?: ScoreFn;
}): Strategy<"rubric"> {
  return {
    name: "rubric",
    bootstrap: (ctx) => bootstrap_rubric(ctx, overrides?.bootstrap_call),
    score: (cfg, ctx) => score_rubric(cfg, ctx, overrides?.score_call),
  };
}

export const rubric_strategy = create_rubric_strategy();

register_strategy(rubric_strategy);

export const _build_scorecard = build_scorecard;
