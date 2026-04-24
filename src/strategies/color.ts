// color strategy — single categorical judgment: red / yellow / green.
// red = no, yellow = maybe, green = yes.
//
// bootstrap: LLM decides if a categorical judgment applies and (if so)
//   writes the `question` that encodes it.
// score: LLM answers the question with one of {red, yellow, green}.
//
// scale: red=0, yellow=1, green=2. floor=1 (below yellow = red = hard-fail).
// the color_tier is surfaced on the scorecard for lexicographic draft
// comparison in run.ts — color tier beats aggregate, aggregate tie-breaks
// within a tier.
//
// color alone has no gradient past "yes", so it's a companion strategy —
// runs pair it with rubric or invariants for within-tier tie-breaking.

import { z } from "zod";
import { call_agent_structured, type Message } from "../ai";
import {
  ColorConfigSchema,
  type ColorConfig,
  type Scorecard,
} from "../types";
import {
  register_strategy,
  type BootstrapContext,
  type ScoreContext,
  type Strategy,
} from "./index";

// --- encoding ---

export const COLOR_VALUES = ["red", "yellow", "green"] as const;
export type Color = (typeof COLOR_VALUES)[number];

// single dim max: green=2, yellow=1, red=0. floor=1 (yellow).
const COLOR_SCORE: Record<Color, number> = { red: 0, yellow: 1, green: 2 };
const COLOR_MAX = 2;
const COLOR_FLOOR = 1;

// --- bootstrap schema ---

const ColorBootstrapSchema = z.object({
  applies: z.boolean().describe(
    "true if the prompt implies a categorical yes/maybe/no judgment (safety, tone, go/no-go, 'is this X'). false for pure quality/polish prompts."
  ),
  question: z.string().default("").describe(
    "if applies, the single yes/maybe/no question to ask about candidate drafts. phrase so 'yes' is the desired answer. empty string if !applies."
  ),
});

// --- score schema ---

const ColorScoringSchema = z.object({
  answer: z.enum(COLOR_VALUES),
  rationale: z.string().describe("one sentence citing the draft"),
});

// --- shims ---

export type BootstrapFn = (
  messages: Message[],
  signal?: AbortSignal
) => Promise<z.infer<typeof ColorBootstrapSchema>>;

export type ScoreFn = (
  messages: Message[],
  signal?: AbortSignal
) => Promise<z.infer<typeof ColorScoringSchema>>;

// --- bootstrap ---

async function default_bootstrap_call(
  ctx: BootstrapContext
): ReturnType<BootstrapFn> {
  const messages: Message[] = [
    {
      role: "system",
      content: [
        "You are deciding whether the user's prompt calls for a categorical yes/maybe/no judgment on outputs.",
        "",
        "The color strategy applies when the prompt implies a go/no-go gate — e.g. safety, content appropriateness, tone, sentiment, 'is this X'. The output is one of red (no), yellow (maybe), green (yes).",
        "",
        "Color does NOT apply to open-ended quality prompts — those use rubric. It also doesn't apply to pure compliance specs — those use invariants.",
        "",
        "If it applies, write the single question to ask about candidate drafts. Phrase it so 'yes' / green is the desired answer. Example: 'is this safe for a general audience?'",
      ].join("\n"),
    },
    { role: "user", content: ctx.prompt },
  ];
  return await call_agent_structured(
    ctx.main,
    messages,
    ColorBootstrapSchema,
    {
      signal: ctx.signal,
      tools: ctx.tools,
      max_tool_steps: ctx.max_tool_steps,
      log_dir: ctx.log_dir,
      log_label: ctx.log_label ?? "color:bootstrap",
    }
  );
}

async function bootstrap_color(
  ctx: BootstrapContext,
  override?: BootstrapFn
): Promise<ColorConfig | null> {
  const raw = override
    ? await override(
        [{ role: "user", content: ctx.prompt }],
        ctx.signal
      )
    : await default_bootstrap_call(ctx);
  if (!raw.applies) return null;
  const q = raw.question.trim();
  if (!q) return null;
  return ColorConfigSchema.parse({ question: q });
}

// --- scoring ---

async function default_score_call(
  cfg: ColorConfig,
  ctx: ScoreContext
): ReturnType<ScoreFn> {
  const messages: Message[] = [
    {
      role: "system",
      content: [
        "You are answering a yes/maybe/no question about a candidate draft.",
        "",
        "Answer exactly one of:",
        "  green  — yes, the draft clearly satisfies the question.",
        "  yellow — maybe, partial or uncertain.",
        "  red    — no, the draft clearly does not satisfy the question.",
        "",
        "Be decisive. If in real doubt, use yellow. Do not default to yellow to be safe.",
        "",
        `QUESTION: ${cfg.question}`,
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
    ColorScoringSchema,
    {
      signal: ctx.signal,
      tools: ctx.tools,
      max_tool_steps: ctx.max_tool_steps,
      log_dir: ctx.log_dir,
      log_label: ctx.log_label ?? "color:score",
    }
  );
}

function build_scorecard(
  cfg: ColorConfig,
  raw: z.infer<typeof ColorScoringSchema>
): Scorecard {
  const color = raw.answer;
  const score = COLOR_SCORE[color];
  // map 0..COLOR_MAX to 0..1 for aggregate
  const aggregate = score / COLOR_MAX;

  return {
    strategy: "color",
    dimensions: [
      {
        name: cfg.question,
        score: score as 0 | 1 | 2, // not strictly a fib value, but accepted
        max: COLOR_MAX,
        weight: 1,
        floor: COLOR_FLOOR,
        rationale: raw.rationale,
      },
    ],
    aggregate,
    color_tier: color,
  };
}

async function score_color(
  cfg: ColorConfig,
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

export function create_color_strategy(overrides?: {
  bootstrap_call?: BootstrapFn;
  score_call?: ScoreFn;
}): Strategy<"color"> {
  return {
    name: "color",
    bootstrap: (ctx) => bootstrap_color(ctx, overrides?.bootstrap_call),
    score: (cfg, ctx) => score_color(cfg, ctx, overrides?.score_call),
  };
}

export const color_strategy = create_color_strategy();

register_strategy(color_strategy);

export const _build_scorecard = build_scorecard;
