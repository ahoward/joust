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

// --- jouster mutation result (zod schema) ---

export const MutationResultSchema = z.object({
  draft: z.string().describe("the full rewritten draft incorporating your critique"),
  critique: z.string().describe("summary of what you changed and why"),
});

export type MutationResult = z.infer<typeof MutationResultSchema>;

// --- compaction result (zod schema) ---

export const CompactionResultSchema = z.object({
  summary: z.string().describe("dense summary of all resolved decisions from the critique trail"),
});

export type CompactionResult = z.infer<typeof CompactionResultSchema>;

// --- agent role ---

export type AgentRole = "jouster" | "lint" | "bootstrap" | "polish" | "compact" | "ask";
