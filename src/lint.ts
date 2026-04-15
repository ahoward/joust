import { call_agent_structured } from "./ai";
import { compile_context, inject_lint_draft } from "./context";
import { log_status } from "./utils";
import { LintResultSchema, type AgentConfig, type LintResult, type Snowball } from "./types";

export async function lint_mutation(
  main_agent: AgentConfig,
  snowball: Snowball,
  mutated_draft: string
): Promise<LintResult> {
  log_status("main", "linting mutation against invariants...");

  const messages = compile_context(main_agent, snowball, "lint");
  const filled = inject_lint_draft(messages, mutated_draft);

  const result = await call_agent_structured(main_agent, filled, LintResultSchema);

  if (result.valid) {
    log_status("main", "lint passed");
  } else {
    log_status("main", `lint FAILED: ${result.violations.join("; ")}`);
  }

  return result;
}
