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
  valid: z.boolean().describe("true if the draft respects all invariants, false if any are violated"),
  violations: z.array(z.string()).describe("list of specific invariant violations found, empty if valid"),
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
