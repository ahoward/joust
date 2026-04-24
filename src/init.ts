import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import type { ToolSet } from "ai";
import "./strategies/invariants";
import "./strategies/rubric";
import "./strategies/color";

import { call_agent_structured } from "./ai";
import { compile_context } from "./context";
import { create_workspace_tools } from "./tools";
import { resolve_config, get_main_agent, generate_default_config, detect_preset, type Preset } from "./config";
import { get_strategy, list_strategies } from "./strategies";
import {
  slugify,
  ensure_dir,
  write_atomic,
  to_json,
  commit_state,
  log,
  log_status,
  set_log_dir,
} from "./utils";
import {
  BootstrapResultSchema,
  type Snowball,
  type HistoryEntry,
  type StrategiesConfig,
  type StrategyName,
  type AgentConfig,
} from "./types";

// --- strategies bootstrap (phase 1 of #42) ---
//
// runs each registered strategy's bootstrap() against the prompt. a
// strategy that returns null is omitted from the final config. errors
// in one strategy don't kill the others (per-strategy try/catch).
async function bootstrap_strategies(
  main: AgentConfig,
  prompt: string,
  options?: {
    tools?: ToolSet;
    max_tool_steps?: number;
    log_dir?: string;
    signal?: AbortSignal;
  }
): Promise<StrategiesConfig> {
  const names = list_strategies();
  log_status("main", `bootstrapping strategies: ${names.join(", ")}`);

  const pairs = await Promise.all(
    names.map(async (name) => {
      const s = get_strategy(name as StrategyName);
      try {
        const cfg = await s.bootstrap({
          prompt,
          main,
          tools: options?.tools,
          max_tool_steps: options?.max_tool_steps,
          log_dir: options?.log_dir,
          signal: options?.signal,
        });
        return [name, cfg] as const;
      } catch (err: any) {
        log_status(name, `bootstrap error: ${err.message}`);
        return [name, null] as const;
      }
    })
  );

  const out: StrategiesConfig = {};
  for (const [name, cfg] of pairs) {
    if (!cfg) continue;
    if (name === "invariants") out.invariants = cfg as any;
    else if (name === "rubric") out.rubric = cfg as any;
    else if (name === "color") out.color = cfg as any;
  }
  return out;
}

// --- read prompt from $EDITOR ---

async function prompt_from_editor(): Promise<string> {
  const editor = process.env.EDITOR || "vi";
  const tmp_file = join(tmpdir(), `joust-prompt-${Date.now()}.md`);

  const instructions = [
    "# Write your prompt below. Lines starting with # are ignored.",
    "# Save and exit to continue. Empty file aborts.",
    "",
    "",
  ].join("\n");

  await Bun.write(tmp_file, instructions);

  const proc = Bun.spawn([editor, tmp_file], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;

  const content = readFileSync(tmp_file, "utf-8");
  const lines = content
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n")
    .trim();

  if (!lines) {
    throw new Error("empty prompt, aborting");
  }

  return lines;
}

// --- read prompt from file or string ---

function read_prompt(input: string): string {
  // check if it's a file path
  if (existsSync(input) && (input.endsWith(".md") || input.endsWith(".txt"))) {
    return readFileSync(input, "utf-8").trim();
  }
  // otherwise treat as raw string
  return input.trim();
}

// --- bootstrap ---

export async function init(args: string[], preset?: Preset): Promise<string> {
  // get the prompt
  let prompt: string;
  if (args.length === 0) {
    prompt = await prompt_from_editor();
  } else {
    prompt = read_prompt(args.join(" "));
  }

  log(`bootstrapping joust from prompt...`);

  // resolve config (no project dir yet)
  const config = resolve_config();
  const main = get_main_agent(config);

  // give bootstrap access to the cwd as workspace — without this, main has to
  // guess at the codebase and invents invariants for the wrong stack (e.g.
  // Ruby gemspec invariants for a Bun/TS project).
  const bootstrap_workspace = process.cwd();
  const workspace_tools = create_workspace_tools(bootstrap_workspace);
  const max_tool_steps = config.defaults.max_tool_steps;

  // create empty snowball with the prompt as the draft
  const seed_snowball: Snowball = {
    invariants: { MUST: [], SHOULD: [], MUST_NOT: [] },
    draft: prompt,
    critique_trail: [],
    resolved_decisions: [],
    human_directives: [],
  };

  // create state directory first so the bootstrap call can tee its full
  // prompt / tool calls / output into logs/agent-main.log.
  const slug = slugify(prompt);
  const dir = resolve(".joust", slug);
  ensure_dir(dir);
  ensure_dir(join(dir, "history"));
  set_log_dir(dir);

  // call main to bootstrap: expand prompt into draft + invariants
  log_status("main", `expanding prompt into draft + invariants (workspace: ${bootstrap_workspace})...`);
  const context = compile_context(main, seed_snowball, "bootstrap", { has_tools: true });
  const result = await call_agent_structured(main, context, BootstrapResultSchema, {
    tools: workspace_tools,
    max_tool_steps,
    log_dir: join(dir, "logs"),
    log_label: "bootstrap",
  });

  // strategy bootstrap (phase 1 of #42) — ask each registered strategy
  // whether it applies to this prompt and collect the config blocks.
  const strategies = await bootstrap_strategies(main, prompt, {
    tools: workspace_tools,
    max_tool_steps,
    log_dir: join(dir, "logs"),
  });

  // build the real snowball — legacy `invariants` kept in place for
  // back-compat (lint_mutation and context.format_invariants read it).
  // `strategies` is the new authoritative config for scoring; run.ts
  // prefers it over the legacy top-level invariants via migrate_snowball.
  const snowball: Snowball = {
    invariants: result.invariants,
    draft: result.draft,
    critique_trail: [],
    resolved_decisions: [],
    human_directives: [],
    strategies,
    best_draft: result.draft,
    aggregate_history: [],
  };

  // write config snapshot — auto-detect preset from env if not specified
  const effective_preset = preset ?? detect_preset();
  log(`preset: ${effective_preset}`);
  write_atomic(join(dir, "config.json"), generate_default_config(effective_preset) + "\n");

  // write seed history entry
  const entry: HistoryEntry = {
    step: 0,
    actor: "main",
    action: "bootstrap",
    status: "seed",
    timestamp: new Date().toISOString(),
    snowball,
  };

  commit_state(dir, 0, "main", entry);

  // log summary
  log(`\ncreated: ${dir}/`);
  log(`  config.json         config (edit before running)`);
  log(`  snowball.json       current state`);
  log(`  history/000-main.json  seed`);
  log(`\ninvariants:`);
  for (const rule of snowball.invariants.MUST) log(`  MUST: ${rule}`);
  for (const rule of snowball.invariants.SHOULD) log(`  SHOULD: ${rule}`);
  for (const rule of snowball.invariants.MUST_NOT) log(`  MUST NOT: ${rule}`);
  const strategy_names = Object.keys(strategies);
  if (strategy_names.length > 0) {
    log(`\nstrategies: ${strategy_names.join(", ")}`);
    if (strategies.rubric) {
      log(`  rubric dims:`);
      for (const d of strategies.rubric.dimensions) {
        log(`    ${d.name} (weight ${d.weight})${d.description ? `: ${d.description}` : ""}`);
      }
    }
    if (strategies.color) {
      log(`  color question: ${strategies.color.question}`);
    }
  }
  log(`\nready. review config and run: joust /run ${dir}/`);

  return dir;
}

// --- exported for tests ---

export const _bootstrap_strategies = bootstrap_strategies;
