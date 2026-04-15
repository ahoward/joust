import { call_agent_structured } from "./ai";
import { compile_context } from "./context";
import { log_status } from "./utils";
import {
  CompactionResultSchema,
  type AgentConfig,
  type Snowball,
} from "./types";

export async function maybe_compact(
  main: AgentConfig,
  snowball: Snowball,
  threshold: number,
  options?: { signal?: AbortSignal }
): Promise<Snowball> {
  if (snowball.critique_trail.length < threshold) return snowball;

  log_status("main", `compacting critique trail (${snowball.critique_trail.length} entries)...`);

  const messages = compile_context(main, snowball, "compact");
  const result = await call_agent_structured(main, messages, CompactionResultSchema, {
    signal: options?.signal,
  });

  log_status("main", "compaction complete");

  return {
    ...snowball,
    critique_trail: [],
    resolved_decisions: [...snowball.resolved_decisions, result.summary],
  };
}
