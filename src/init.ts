import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { call_agent_structured } from "./ai";
import { compile_context } from "./context";
import { resolve_config, get_main_agent, generate_default_config, detect_preset, type Preset } from "./config";
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

  // create empty snowball with the prompt as the draft
  const seed_snowball: Snowball = {
    invariants: { MUST: [], SHOULD: [], MUST_NOT: [] },
    draft: prompt,
    critique_trail: [],
    resolved_decisions: [],
    human_directives: [],
  };

  // call main to bootstrap: expand prompt into draft + invariants
  log_status("main", "expanding prompt into draft + invariants...");
  const context = compile_context(main, seed_snowball, "bootstrap");
  const result = await call_agent_structured(main, context, BootstrapResultSchema);

  // build the real snowball
  const snowball: Snowball = {
    invariants: result.invariants,
    draft: result.draft,
    critique_trail: [],
    resolved_decisions: [],
    human_directives: [],
  };

  // create state directory under .joust/
  const slug = slugify(prompt);
  const dir = resolve(".joust", slug);
  ensure_dir(dir);
  ensure_dir(join(dir, "history"));
  set_log_dir(dir);

  // write config snapshot — auto-detect preset from env if not specified
  const effective_preset = preset ?? detect_preset();
  log(`preset: ${effective_preset}`);
  write_atomic(join(dir, "rfc.yaml"), generate_default_config(effective_preset));

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
  log(`  rfc.yaml            config (edit before running)`);
  log(`  snowball.json       current state`);
  log(`  history/000-main.json  seed`);
  log(`\ninvariants:`);
  for (const rule of snowball.invariants.MUST) log(`  MUST: ${rule}`);
  for (const rule of snowball.invariants.SHOULD) log(`  SHOULD: ${rule}`);
  for (const rule of snowball.invariants.MUST_NOT) log(`  MUST NOT: ${rule}`);
  log(`\nready. review config and run: joust /run ${dir}/`);

  return dir;
}
