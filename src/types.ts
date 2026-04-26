import { z } from "zod";

// --- snowball ---

export interface Invariants {
  MUST: string[];
  SHOULD: string[];
  MUST_NOT: string[];
}

export interface CritiqueEntry {
  actor: string;
  action: string;
  notes: string;
  timestamp: string;
}

export interface Snowball {
  invariants: Invariants;
  draft: string;
  critique_trail: CritiqueEntry[];
  resolved_decisions: string[];
  human_directives: string[];
  // strategy-scoring fields (#42). all optional for migration: legacy
  // snapshots lack these and are rehydrated into a single-strategy
  // `invariants` shape on load.
  strategies?: StrategiesConfig;
  best_draft?: string;
  best_scoring?: ScoringResult;
  aggregate_history?: number[];  // for plateau detection across rounds
}

// --- history ---

export type HistoryStatus = "accepted" | "rejected" | "aborted" | "seed";

export interface HistoryEntry {
  step: number;
  actor: string;
  action: string;
  status: HistoryStatus;
  timestamp: string;
  snowball: Snowball;
  violations?: string[];
}

// --- validation schemas for loading persisted state ---

const InvariantsSchema = z.object({
  MUST: z.array(z.string()),
  SHOULD: z.array(z.string()),
  MUST_NOT: z.array(z.string()),
});

const CritiqueEntrySchema = z.object({
  actor: z.string(),
  action: z.string(),
  notes: z.string(),
  timestamp: z.string(),
});

export const SnowballSchema = z.object({
  invariants: InvariantsSchema,
  draft: z.string(),
  critique_trail: z.array(CritiqueEntrySchema),
  resolved_decisions: z.array(z.string()),
  human_directives: z.array(z.string()),
  // strategy-scoring fields — optional; validated loosely (z.any) so we
  // don't need forward refs to the strategy schemas defined below.
  // runtime code does proper StrategiesConfigSchema.parse on load.
  strategies: z.any().optional(),
  best_draft: z.string().optional(),
  best_scoring: z.any().optional(),
  aggregate_history: z.array(z.number()).optional(),
});

export const HistoryEntrySchema = z.object({
  step: z.number(),
  actor: z.string(),
  action: z.string(),
  status: z.enum(["accepted", "rejected", "aborted", "seed"]),
  timestamp: z.string(),
  snowball: SnowballSchema,
  violations: z.array(z.string()).optional(),
});

// --- config ---

export interface AgentConfig {
  name: string;
  model: string;
  api_key: string;
  system: string;
  temperature?: number;
}

export interface JoustDefaults {
  temperature: number;
  max_retries: number;
  compaction_threshold: number;
  max_rounds: number;
  workspace?: string;
  max_tool_steps?: number;
  // strategy-scoring plateau detection (#49). loop ends when the
  // best_aggregate hasn't improved by > plateau_epsilon across the
  // last (plateau_k + 1) rounds.
  plateau_epsilon?: number;
  plateau_k?: number;
}

export interface JoustConfig {
  defaults: JoustDefaults;
  agents: Record<string, AgentConfig>;
}

// --- lint result (zod schema for structured output) ---

export const LintResultSchema = z.object({
  valid: z.boolean().describe("true if the draft respects all MUST invariants, false if any MUST rules are violated"),
  violations: z.array(z.string()).describe("list of specific MUST invariant violations found, empty if valid"),
  should_violations: z.array(z.object({
    rule: z.string().describe("the SHOULD rule that was violated"),
    justified: z.boolean().describe("true if the jouster provided acceptable justification for the violation"),
    justification: z.string().optional().describe("the jouster's justification for violating this SHOULD rule"),
  })).optional().describe("SHOULD violations — these do not invalidate the draft if justified"),
});

export type LintResult = z.infer<typeof LintResultSchema>;

// --- bootstrap result (zod schema for structured output from main) ---

export const BootstrapResultSchema = z.object({
  invariants: z.object({
    MUST: z.array(z.string()).describe("things the architecture absolutely must do"),
    SHOULD: z.array(z.string()).describe("things the architecture should do if possible"),
    MUST_NOT: z.array(z.string()).describe("things the architecture must never do"),
  }),
  draft: z.string().describe("the initial architecture draft in markdown"),
});

export type BootstrapResult = z.infer<typeof BootstrapResultSchema>;

// --- specialist summon (zod schema) ---
// when a lead architect (main or peer) thinks a specialist review is warranted,
// they attach a summon to their mutation. The ask is a specific, scoped question.

export const SPECIALIST_NAMES = ["security", "cfo", "dba", "perf", "ux", "legal"] as const;
export type SpecialistName = (typeof SPECIALIST_NAMES)[number];

export const SummonSchema = z.object({
  specialist: z.enum(SPECIALIST_NAMES)
    .describe("which specialist to summon for a one-shot scoped review"),
  ask: z.string().min(1)
    .describe("specific, scoped question for the specialist (not vague — e.g. 'evaluate whether the token-refresh flow is replay-vulnerable')"),
});

export type Summon = z.infer<typeof SummonSchema>;

// --- jouster mutation result (zod schema) ---

export const MutationResultSchema = z.object({
  draft: z.string().describe("the full rewritten draft incorporating your critique"),
  critique: z.string().describe("summary of what you changed and why"),
  summon: SummonSchema.optional().describe(
    "OPTIONAL. Only set this if the draft raises a concrete concern outside your expertise " +
    "that warrants a specialist review. Leave absent for normal mutations."
  ),
});

export type MutationResult = z.infer<typeof MutationResultSchema>;

// --- compaction result (zod schema) ---

export const CompactionResultSchema = z.object({
  summary: z.string().describe("dense summary of all resolved decisions from the critique trail"),
});

export type CompactionResult = z.infer<typeof CompactionResultSchema>;

// --- agent role ---

export type AgentRole = "jouster" | "lint" | "bootstrap" | "polish" | "compact" | "ask" | "specialist";

// --- strategies (phase 1 of #42) ---
//
// a strategy is a scoring lens. drafts are evaluated against one or more
// strategies; each produces a Scorecard. the loop compares drafts
// lexicographically by (color_tier, weighted_aggregate).

// fibonacci scale: 0, 1, 2, 3, 5, 8, 13. widely-spaced so LLM scorers
// can't cluster in the middle; boolean "met/not-met" maps to 0 or 13.
export const FIB_SCALE = [0, 1, 2, 3, 5, 8, 13] as const;
export type FibScore = (typeof FIB_SCALE)[number];

export const FibScoreSchema = z.number().int().refine(
  (n): n is FibScore => (FIB_SCALE as readonly number[]).includes(n),
  { message: "score must be one of 0, 1, 2, 3, 5, 8, 13" }
);

// one scored dimension within a scorecard. `floor` is a hard failure
// threshold — if score < floor, the run fails regardless of aggregate.
export const DimensionScoreSchema = z.object({
  name: z.string(),
  score: FibScoreSchema,
  max: z.number().int().positive(),
  weight: z.number().positive().default(1),
  floor: z.number().int().optional(),
  rationale: z.string(),
});
export type DimensionScore = z.infer<typeof DimensionScoreSchema>;

// a scorecard is the output of one strategy's score() call.
// aggregate is a normalized 0..1 weighted mean across dimensions.
export const ScorecardSchema = z.object({
  strategy: z.string(),
  dimensions: z.array(DimensionScoreSchema),
  aggregate: z.number().min(0).max(1),
  // color-tier only set by the color strategy. "red" | "yellow" | "green"
  // surfaced at the scorecard level for lexicographic comparison.
  color_tier: z.enum(["red", "yellow", "green"]).optional(),
});
export type Scorecard = z.infer<typeof ScorecardSchema>;

export interface Violation {
  strategy: string;
  dimension: string;
  score: number;
  floor: number;
  rationale: string;
}

// aggregate lint output across all configured strategies.
export interface ScoringResult {
  scorecards: Scorecard[];
  weighted_aggregate: number;      // mean of per-strategy aggregates
  color_tier: "red" | "yellow" | "green" | null;  // null if color not configured
  floor_violations: Violation[];
  passed: boolean;                 // floor_violations.length === 0
}

// --- strategies config shape ---
//
// persisted in config.json as a top-level `strategies:` block. each key
// corresponds to a built-in strategy. omitted strategies are "off".
//
// rubric: free-form dimensions with LLM-assigned scores on fib scale.
// invariants: MUST/SHOULD/MUST_NOT mapped to fib dims (MUST gets floor=13).
// color: single-dim question answered red/yellow/green.

export const RubricDimensionConfigSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  weight: z.number().positive().default(1),
  max: z.number().int().positive().default(13),
});
export type RubricDimensionConfig = z.infer<typeof RubricDimensionConfigSchema>;

export const RubricConfigSchema = z.object({
  dimensions: z.array(RubricDimensionConfigSchema).min(1),
});
export type RubricConfig = z.infer<typeof RubricConfigSchema>;

export const InvariantsConfigSchema = z.object({
  MUST: z.array(z.string()).default([]),
  SHOULD: z.array(z.string()).default([]),
  MUST_NOT: z.array(z.string()).default([]),
});
export type InvariantsConfig = z.infer<typeof InvariantsConfigSchema>;

export const ColorConfigSchema = z.object({
  question: z.string().min(1),
});
export type ColorConfig = z.infer<typeof ColorConfigSchema>;

export const StrategiesConfigSchema = z.object({
  rubric: RubricConfigSchema.optional(),
  invariants: InvariantsConfigSchema.optional(),
  color: ColorConfigSchema.optional(),
});
export type StrategiesConfig = z.infer<typeof StrategiesConfigSchema>;
