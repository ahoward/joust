import { call_agent_structured } from "./ai";
import { compile_context } from "./context";
import { log_status } from "./utils";
import { LintResultSchema, type AgentConfig, type LintResult, type Snowball } from "./types";
import type { ToolSet } from "ai";

export async function lint_mutation(
  main_agent: AgentConfig,
  snowball: Snowball,
  mutated_draft: string,
  options?: { tools?: ToolSet; max_tool_steps?: number }
): Promise<LintResult> {
  log_status("main", "linting mutation against invariants...");

  const messages = compile_context(main_agent, snowball, "lint", {
    mutated_draft,
    has_tools: !!options?.tools,
  });

  const result = await call_agent_structured(main_agent, messages, LintResultSchema, {
    tools: options?.tools,
    max_tool_steps: options?.max_tool_steps,
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
