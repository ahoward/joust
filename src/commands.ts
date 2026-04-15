import { resolve, join } from "path";
import { readFileSync } from "fs";
import { scan_history, read_latest_history, log } from "./utils";
import { compile_context, estimate_tokens } from "./context";
import { call_agent } from "./ai";
import { resolve_config, get_main_agent, get_jousters } from "./config";
import type { HistoryEntry } from "./types";

// --- joust status ---

export function status(dir: string): void {
  dir = resolve(dir);
  const files = scan_history(dir);
  const latest = read_latest_history(dir);

  if (!latest) {
    log("no history found — run 'joust init' first");
    return;
  }

  const snowball = latest.snowball;
  const word_count = snowball.draft.split(/\s+/).length;
  const accepted = files.filter((f) => {
    try {
      const entry = JSON.parse(readFileSync(f.path, "utf-8"));
      return entry.status === "accepted";
    } catch { return false; }
  }).length;
  const rejected = files.length - accepted;

  log(`=== joust status ===`);
  log(`step:       ${latest.step} (${latest.actor}/${latest.action})`);
  log(`status:     ${latest.status}`);
  log(`history:    ${files.length} entries (${accepted} accepted, ${rejected} rejected/other)`);
  log(`invariants: ${snowball.invariants.MUST.length} MUST, ${snowball.invariants.SHOULD.length} SHOULD, ${snowball.invariants.MUST_NOT.length} MUST NOT`);
  log(`draft:      ${word_count} words, ${snowball.draft.length} chars`);
  log(`trail:      ${snowball.critique_trail.length} critiques`);
  log(`decisions:  ${snowball.resolved_decisions.length} compacted`);
  log(`directives: ${snowball.human_directives.length} human`);
}

// --- joust export ---

export function export_draft(dir: string): void {
  dir = resolve(dir);
  const latest = read_latest_history(dir);

  if (!latest) {
    log("no history found — run 'joust init' first");
    process.exit(1);
  }

  process.stdout.write(latest.snowball.draft);
}

// --- joust diff ---

export function diff(dir: string, step1?: string, step2?: string): void {
  dir = resolve(dir);
  const files = scan_history(dir);

  if (files.length < 2 && !step1) {
    log("need at least 2 history entries for diff");
    return;
  }

  const load_entry = (step_str: string): HistoryEntry | null => {
    const step_num = parseInt(step_str, 10);
    const file = files.find((f) => f.step === step_num);
    if (!file) { log(`step ${step_str} not found`); return null; }
    try {
      return JSON.parse(readFileSync(file.path, "utf-8"));
    } catch { log(`failed to read step ${step_str}`); return null; }
  };

  let entry_a: HistoryEntry | null;
  let entry_b: HistoryEntry | null;

  if (step1 && step2) {
    entry_a = load_entry(step1);
    entry_b = load_entry(step2);
  } else {
    // default: last two entries
    const a_file = files[files.length - 2];
    const b_file = files[files.length - 1];
    try {
      entry_a = JSON.parse(readFileSync(a_file.path, "utf-8"));
      entry_b = JSON.parse(readFileSync(b_file.path, "utf-8"));
    } catch {
      log("failed to read history entries");
      return;
    }
  }

  if (!entry_a || !entry_b) return;

  const lines_a = entry_a.snowball.draft.split("\n");
  const lines_b = entry_b.snowball.draft.split("\n");

  // simple line-by-line diff output
  log(`--- step ${entry_a.step} (${entry_a.actor}/${entry_a.action})`);
  log(`+++ step ${entry_b.step} (${entry_b.actor}/${entry_b.action})`);

  const max = Math.max(lines_a.length, lines_b.length);
  for (let i = 0; i < max; i++) {
    const a = lines_a[i];
    const b = lines_b[i];
    if (a === b) continue;
    if (a !== undefined && b === undefined) {
      log(`-${i + 1}: ${a}`);
    } else if (a === undefined && b !== undefined) {
      log(`+${i + 1}: ${b}`);
    } else if (a !== b) {
      log(`-${i + 1}: ${a}`);
      log(`+${i + 1}: ${b}`);
    }
  }
}

// --- joust plan ---

// approximate costs per 1M tokens (input)
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 0.80, output: 4 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gpt-4o": { input: 2.50, output: 10 },
};

export function plan(dir: string): void {
  dir = resolve(dir);
  const config = resolve_config(dir);
  const main = get_main_agent(config);
  const jousters = get_jousters(config);
  const max_rounds = config.defaults.max_rounds;
  const max_retries = config.defaults.max_retries;

  const latest = read_latest_history(dir);
  const draft_chars = latest ? latest.snowball.draft.length : 5000; // estimate for new runs
  const draft_tokens = Math.ceil(draft_chars / 4);

  // per round: each jouster does mutation + lint, main does polish
  // each call sends ~draft + context overhead
  const context_overhead = 2000; // tokens for system prompt, invariants, trail summary
  const tokens_per_call = draft_tokens + context_overhead;

  const jouster_calls_per_round = jousters.length * (1 + 1); // mutation + lint per jouster
  const polish_calls = 1;
  const calls_per_round = jouster_calls_per_round + polish_calls;
  const total_calls = calls_per_round * max_rounds;
  const total_input_tokens = total_calls * tokens_per_call;
  // output is roughly draft size for mutations, small for lint
  const total_output_tokens = Math.ceil(total_input_tokens * 0.5);

  log(`=== joust plan ===`);
  log(`agents: main (${main.model}) + ${jousters.length} jousters`);
  for (const j of jousters) {
    log(`  - ${j.name} (${j.model})`);
  }
  log(`rounds: ${max_rounds} | retries: ${max_retries}/agent`);
  log(`draft:  ~${draft_tokens} tokens (${draft_chars} chars)`);
  log(`calls:  ~${total_calls} API calls (${calls_per_round}/round)`);
  log(`tokens: ~${Math.round(total_input_tokens / 1000)}K input, ~${Math.round(total_output_tokens / 1000)}K output`);
  log(``);

  // cost breakdown by model
  const model_usage: Record<string, { input: number; output: number }> = {};
  // main: lint + polish calls
  const main_calls = (jousters.length + 1) * max_rounds; // lint per jouster + polish
  const main_key = main.model;
  model_usage[main_key] = {
    input: (model_usage[main_key]?.input ?? 0) + main_calls * tokens_per_call,
    output: (model_usage[main_key]?.output ?? 0) + main_calls * Math.ceil(tokens_per_call * 0.3),
  };
  for (const j of jousters) {
    const key = j.model;
    const j_calls = max_rounds; // 1 mutation per round
    model_usage[key] = {
      input: (model_usage[key]?.input ?? 0) + j_calls * tokens_per_call,
      output: (model_usage[key]?.output ?? 0) + j_calls * draft_tokens, // outputs a full draft
    };
  }

  let total_cost = 0;
  log(`estimated cost:`);
  for (const [model, usage] of Object.entries(model_usage)) {
    const cost_info = MODEL_COSTS[model];
    if (cost_info) {
      const cost = (usage.input / 1_000_000) * cost_info.input +
                   (usage.output / 1_000_000) * cost_info.output;
      total_cost += cost;
      log(`  ${model}: $${cost.toFixed(2)} (${Math.round(usage.input / 1000)}K in, ${Math.round(usage.output / 1000)}K out)`);
    } else {
      log(`  ${model}: unknown pricing (${Math.round(usage.input / 1000)}K in, ${Math.round(usage.output / 1000)}K out)`);
    }
  }
  if (total_cost > 0) {
    log(`  total: ~$${total_cost.toFixed(2)}`);
  }
  log(`\nnote: estimates assume no retries. with retries, multiply by up to ${max_retries}x.`);
}

// --- joust ask ---

export async function ask(dir: string, agent_name: string, question: string): Promise<void> {
  dir = resolve(dir);
  const config = resolve_config(dir);
  const all_agents = config.agents;
  const agent = all_agents[agent_name];

  if (!agent) {
    log(`agent '${agent_name}' not found. available: ${Object.keys(all_agents).join(", ")}`);
    process.exit(1);
  }

  const latest = read_latest_history(dir);
  if (!latest) {
    log("no history found — run 'joust init' first");
    process.exit(1);
  }

  const snowball = latest.snowball;
  const messages = compile_context(agent, snowball, "jouster");

  // replace the last message (draft prompt) with the user's question
  messages[messages.length - 1] = {
    role: "user",
    content: question,
  };

  const response = await call_agent(agent, messages);
  process.stdout.write(response);
}
