// lint — strategy dispatcher (phase 1 of #42).
//
// given a candidate draft and a StrategiesConfig, runs every configured
// strategy's score() in parallel and aggregates into a ScoringResult.
// a run fails if any dim scored < its floor.
//
// the strategy modules self-register via `import`; importing this file
// pulls them in. lint is the only module that needs to know the full
// set of built-in strategies.

import "./strategies/invariants";
import "./strategies/rubric";
import "./strategies/color";

import { get_strategy } from "./strategies";
import type {
  AgentConfig,
  Scorecard,
  ScoringResult,
  Snowball,
  StrategiesConfig,
  Violation,
} from "./types";

// --- collect floor violations from all scorecards ---

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

// --- score a draft against a StrategiesConfig ---
//
// per-strategy scorecards, mean-of-means weighted aggregate, color tier,
// floor violations, passed=true when no violations.
//
// strategies run in parallel; if one errors, it's re-thrown — callers
// can wrap in tank_execute for retry semantics.

export async function score_draft(
  main: AgentConfig,
  strategies: StrategiesConfig,
  snowball: Snowball,
  candidate_draft: string,
  options?: { signal?: AbortSignal }
): Promise<ScoringResult> {
  const tasks: Promise<Scorecard>[] = [];

  if (strategies.rubric) {
    const s = get_strategy("rubric");
    tasks.push(
      s.score(strategies.rubric, {
        main,
        snowball,
        candidate_draft,
        signal: options?.signal,
      })
    );
  }

  if (strategies.invariants) {
    const s = get_strategy("invariants");
    tasks.push(
      s.score(strategies.invariants, {
        main,
        snowball,
        candidate_draft,
        signal: options?.signal,
      })
    );
  }

  if (strategies.color) {
    const s = get_strategy("color");
    tasks.push(
      s.score(strategies.color, {
        main,
        snowball,
        candidate_draft,
        signal: options?.signal,
      })
    );
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

// --- lexicographic comparison for best-so-far tracking ---
//
// a > b when a has a higher color tier, OR color tiers are equal/absent
// AND a has the higher weighted_aggregate. returns 1/0/-1.
// ignores passed/violations — caller should filter failing results.

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

