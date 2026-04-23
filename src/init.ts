import { existsSync, readFileSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import "./strategies/invariants";
import "./strategies/rubric";
import "./strategies/color";

import { call_agent_structured } from "./ai";
import { compile_context } from "./context";
import { resolve_config, get_main_agent, generate_default_config } from "./config";
import { get_strategy, list_strategies } from "./strategies";
import {
  slugify,
  ensure_dir,
  write_atomic,
  commit_state,
  log,
  log_status,
} from "./utils";
import {
  BootstrapResultSchema,
  type Snowball,
  type HistoryEntry,
  type StrategiesConfig,
  type StrategyName,
  type AgentConfig,
} from "./types";

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
  try { unlinkSync(tmp_file); } catch {}
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
  if (existsSync(input) && (input.endsWith(".md") || input.endsWith(".txt"))) {
    return readFileSync(input, "utf-8").trim();
  }
  return input.trim();
}

// --- strategies bootstrap ---
//
// run every registered strategy's bootstrap() against the prompt. a
// strategy that returns null is omitted from the final config. the
// result is what gets persisted to snowball.strategies and drives
// lint in subsequent rounds.
//
// bootstraps run in parallel — they are read-only classifier calls,
// independent, and use the same main agent.

async function bootstrap_strategies(
  main: AgentConfig,
  prompt: string,
  signal?: AbortSignal
): Promise<StrategiesConfig> {
  const names = list_strategies();
  log_status("main", `bootstrapping strategies: ${names.join(", ")}`);

  const pairs = await Promise.all(
    names.map(async (name) => {
      const s = get_strategy(name as StrategyName);
      try {
        const cfg = await s.bootstrap({ prompt, main, signal });
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

// --- init ---

export async function init(args: string[], _options: { run_after?: boolean } = {}): Promise<string> {
  let prompt: string;
  if (args.length === 0) {
    prompt = await prompt_from_editor();
  } else {
    prompt = read_prompt(args.join(" "));
  }

  log(`bootstrapping joust from prompt...`);

  const config = resolve_config();
  const main = get_main_agent(config);

  const seed_snowball: Snowball = {
    invariants: { MUST: [], SHOULD: [], MUST_NOT: [] },
    draft: prompt,
    critique_trail: [],
    resolved_decisions: [],
    human_directives: [],
  };

  // 1) expand the prompt into a first-pass draft via the legacy bootstrap
  //    path (its invariants are informative; the real strategies config
  //    comes from step 2 below).
  log_status("main", "expanding prompt into draft...");
  const context = compile_context(main, seed_snowball, "bootstrap");
  const bootstrap_result = await call_agent_structured(main, context, BootstrapResultSchema);

  // 2) ask each strategy to bootstrap its own config from the prompt.
  const strategies = await bootstrap_strategies(main, prompt);

  // log what got picked
  const picked = Object.keys(strategies);
  if (picked.length === 0) {
    log(`  [no strategies applied — runs will accept every mutation trivially]`);
  } else {
    log(`  strategies: ${picked.join(", ")}`);
  }

  const snowball: Snowball = {
    invariants: bootstrap_result.invariants,  // kept for migration/back-compat
    draft: bootstrap_result.draft,
    critique_trail: [],
    resolved_decisions: [],
    human_directives: [],
    strategies,
    best_draft: bootstrap_result.draft,
    aggregate_history: [],
  };

  const slug = slugify(prompt);
  const dir = resolve(slug);
  ensure_dir(dir);
  ensure_dir(join(dir, "history"));
  ensure_dir(join(dir, "logs"));

  write_atomic(join(dir, "rfc.yaml"), generate_default_config());

  const entry: HistoryEntry = {
    step: 0,
    actor: "main",
    action: "bootstrap",
    status: "seed",
    timestamp: new Date().toISOString(),
    snowball,
  };

  commit_state(dir, 0, "main", entry);

  log(`\ncreated: ${dir}/`);
  log(`  rfc.yaml            config (edit before running)`);
  log(`  snowball.json       current state (strategies inline)`);
  log(`  history/000-main.json  seed`);
  if (strategies.invariants) {
    log(`\ninvariants:`);
    for (const r of strategies.invariants.MUST) log(`  MUST: ${r}`);
    for (const r of strategies.invariants.SHOULD) log(`  SHOULD: ${r}`);
    for (const r of strategies.invariants.MUST_NOT) log(`  MUST NOT: ${r}`);
  }
  if (strategies.rubric) {
    log(`\nrubric dimensions:`);
    for (const d of strategies.rubric.dimensions) {
      log(`  ${d.name} (weight ${d.weight})${d.description ? `: ${d.description}` : ""}`);
    }
  }
  if (strategies.color) {
    log(`\ncolor question:`);
    log(`  ${strategies.color.question}`);
  }
  log(`\nready. review config and run: joust run ${dir}/`);

  return dir;
}

// --- export for tests ---

export const _bootstrap_strategies = bootstrap_strategies;
