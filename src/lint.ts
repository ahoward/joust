// lint — legacy invariants check + strategy dispatcher (phase 1 of #42).
//
// lint_mutation (legacy): the original MUST/SHOULD/MUST_NOT gate. still
// used by run.ts at the polish pass. kept for back-compat while strategies
// migrate in.
//
// score_draft: runs every configured strategy's score() in parallel and
// aggregates into a ScoringResult. a run fails if any dim scores < its
// floor. the strategy modules self-register on import — importing this
// file pulls them in.
//
// compare_results: lexicographic (color_tier, weighted_aggregate).
// run.ts uses this for best-so-far tracking.

import "./strategies/invariants";
import "./strategies/rubric";
import "./strategies/color";

import { call_agent_structured } from "./ai";
import { compile_context } from "./context";
import { get_strategy } from "./strategies";
import { log_status } from "./utils";
import {
  LintResultSchema,
  type AgentConfig,
  type LintResult,
  type Scorecard,
  type ScoringResult,
  type Snowball,
  type StrategiesConfig,
  type Violation,
} from "./types";
import type { ToolSet } from "ai";

export async function lint_mutation(
  main_agent: AgentConfig,
  snowball: Snowball,
  mutated_draft: string,
  options?: { tools?: ToolSet; max_tool_steps?: number; log_dir?: string; log_label?: string }
): Promise<LintResult> {
  log_status("main", "linting mutation against invariants...");

  const messages = compile_context(main_agent, snowball, "lint", {
    mutated_draft,
    has_tools: !!options?.tools,
  });

  const result = await call_agent_structured(main_agent, messages, LintResultSchema, {
    tools: options?.tools,
    max_tool_steps: options?.max_tool_steps,
    log_dir: options?.log_dir,
    log_label: options?.log_label ?? "lint",
  });

  // MUST violations are hard failures
  if (!result.valid) {
    log_status("main", `lint FAILED: ${result.violations.join("; ")}`);
    return result;
  }

  // SHOULD violations with no justification also fail
  const unjustified = (result.should_violations ?? []).filter((v) => !v.justified);
  if (unjustified.length > 0) {
    const reasons = unjustified.map((v) => v.rule);
    log_status("main", `lint FAILED (unjustified SHOULD): ${reasons.join("; ")}`);
    return {
      ...result,
      valid: false,
      violations: [...result.violations, ...reasons.map((r) => `SHOULD: ${r} (unjustified)`)],
    };
  }

  // justified SHOULD violations are fine — just log them
  const justified = (result.should_violations ?? []).filter((v) => v.justified);
  if (justified.length > 0) {
    log_status("main", `lint passed (${justified.length} justified SHOULD violations)`);
  } else {
    log_status("main", "lint passed");
  }

  return result;
}

// --- strategy scoring (phase 1 of #42) ---

interface ScoreOptions {
  signal?: AbortSignal;
  tools?: ToolSet;
  max_tool_steps?: number;
  log_dir?: string;
  log_label?: string;
}

// collect floor violations from all scorecards.
function collect_violations(cards: Scorecard[]): Violation[] {
  const out: Violation[] = [];
  for (const card of cards) {
    for (const d of card.dimensions) {
      if (d.floor !== undefined && d.score < d.floor) {
        out.push({
          strategy: card.strategy,
          dimension: d.name,
          score: d.score,
          floor: d.floor,
          rationale: d.rationale,
        });
      }
    }
  }
  return out;
}

// score a draft against a StrategiesConfig. returns per-strategy scorecards,
// mean-of-means aggregate, color tier (if configured), floor violations.
// strategies run in parallel; errors propagate to the caller (wrap in
// tank_execute for retry semantics).
export async function score_draft(
  main: AgentConfig,
  strategies: StrategiesConfig,
  snowball: Snowball,
  candidate_draft: string,
  options?: ScoreOptions
): Promise<ScoringResult> {
  const shared = {
    signal: options?.signal,
    tools: options?.tools,
    max_tool_steps: options?.max_tool_steps,
    log_dir: options?.log_dir,
    log_label: options?.log_label,
  };

  const tasks: Promise<Scorecard>[] = [];

  if (strategies.rubric) {
    const s = get_strategy("rubric");
    tasks.push(s.score(strategies.rubric, { main, snowball, candidate_draft, ...shared }));
  }

  if (strategies.invariants) {
    const s = get_strategy("invariants");
    tasks.push(s.score(strategies.invariants, { main, snowball, candidate_draft, ...shared }));
  }

  if (strategies.color) {
    const s = get_strategy("color");
    tasks.push(s.score(strategies.color, { main, snowball, candidate_draft, ...shared }));
  }

  const scorecards = await Promise.all(tasks);
  const floor_violations = collect_violations(scorecards);

  const weighted_aggregate =
    scorecards.length === 0
      ? 1
      : scorecards.reduce((s, c) => s + c.aggregate, 0) / scorecards.length;

  const color_card = scorecards.find((c) => c.strategy === "color");
  const color_tier = color_card?.color_tier ?? null;

  return {
    scorecards,
    weighted_aggregate,
    color_tier,
    floor_violations,
    passed: floor_violations.length === 0,
  };
}

// lexicographic comparison: color tier first, then weighted aggregate.
// returns 1 if a is better, -1 if b is better, 0 if equal.
// ignores passed/violations — caller filters failing results first.
const TIER_RANK: Record<string, number> = { red: 0, yellow: 1, green: 2 };

export function compare_results(a: ScoringResult, b: ScoringResult): number {
  if (a.color_tier && b.color_tier) {
    const ra = TIER_RANK[a.color_tier] ?? 0;
    const rb = TIER_RANK[b.color_tier] ?? 0;
    if (ra !== rb) return ra > rb ? 1 : -1;
  }
  if (a.weighted_aggregate > b.weighted_aggregate) return 1;
  if (a.weighted_aggregate < b.weighted_aggregate) return -1;
  return 0;
}
