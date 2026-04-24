// strategies — phase 1 of #42. see spool/gh/issue/42-strategy-scoring/
//
// a Strategy is a scoring lens. each strategy knows how to:
//   - bootstrap: produce its config block from the user's prompt
//   - score:     rate a draft against that config, returning a Scorecard
//
// strategies are stateless; their config lives in rfc.yaml under
// `strategies.<name>`, and their scoring runs through the main agent
// (same LLM pattern as existing lint/polish). nothing here performs I/O
// or network calls directly — callers provide the agent handle.

import type { z } from "zod";
import type {
  AgentConfig,
  Scorecard,
  Snowball,
  StrategiesConfig,
} from "../types";

// the name a strategy is registered under. phase 1 ships three.
export type StrategyName = "rubric" | "invariants" | "color";

// the subset of StrategiesConfig a single strategy's bootstrap() can produce.
// e.g. rubric.bootstrap returns a RubricConfig or null (not-applicable).
export interface BootstrapContext {
  prompt: string;
  main: AgentConfig;
  signal?: AbortSignal;
}

export interface ScoreContext {
  main: AgentConfig;
  snowball: Snowball;
  candidate_draft: string;
  signal?: AbortSignal;
}

// the per-strategy typed config. this maps a strategy name to the shape
// of its slot in StrategiesConfig — e.g. config for `rubric` is
// `StrategiesConfig["rubric"]` (which is `RubricConfig | undefined`).
export type StrategyConfig<N extends StrategyName> =
  NonNullable<StrategiesConfig[N]>;

export interface Strategy<N extends StrategyName = StrategyName> {
  readonly name: N;

  // inspect the prompt. return a config block if this strategy applies,
  // or null if it doesn't. the caller merges the returned blocks into
  // StrategiesConfig; a strategy that returns null is omitted from config.
  bootstrap(ctx: BootstrapContext): Promise<StrategyConfig<N> | null>;

  // score a candidate draft against the given config. returns a Scorecard
  // with per-dim scores on the fib scale + a normalized aggregate.
  score(config: StrategyConfig<N>, ctx: ScoreContext): Promise<Scorecard>;
}

// registry — populated by the individual strategy modules as they're added
// (steps 2-4 of #42). kept as a mutable map so tests can stub a single
// strategy without touching the others.

const _registry = new Map<StrategyName, Strategy<any>>();

export function register_strategy<N extends StrategyName>(s: Strategy<N>): void {
  _registry.set(s.name, s as Strategy<any>);
}

export function get_strategy<N extends StrategyName>(name: N): Strategy<N> {
  const s = _registry.get(name);
  if (!s) throw new Error(`strategy '${name}' is not registered`);
  return s as Strategy<N>;
}

export function list_strategies(): StrategyName[] {
  return Array.from(_registry.keys());
}

// test/reset hook — do NOT use in production code. only tests call this
// between cases to get a clean registry.
export function _reset_strategies(): void {
  _registry.clear();
}
