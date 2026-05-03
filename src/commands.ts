import { resolve, join } from "path";
import { readFileSync } from "fs";
import { scan_history, read_latest_history, log, write_stdout, set_log_dir } from "./utils";
import { compile_context, estimate_tokens } from "./context";
import { call_agent } from "./ai";
import { resolve_config, get_main_agent, get_jousters } from "./config";
import { create_workspace_tools } from "./tools";
import { JoustUserError } from "./errors";
import { sparkline } from "./sparkline";
import type { HistoryEntry } from "./types";

// --- joust status ---

export function status(dir: string, opts: { json?: boolean } = {}): void {
  dir = resolve(dir);
  const files = scan_history(dir);
  const latest = read_latest_history(dir);

  if (!latest) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ error: "no history found", dir }) + "\n");
    } else {
      log("no history found — run 'joust init' first");
    }
    return;
  }

  // --- machine-readable form (#60) ---
  if (opts.json) {
    const snow: any = latest.snowball;
    const accepted = files.filter((f) => {
      try {
        const e = JSON.parse(readFileSync(f.path, "utf-8"));
        return e.status === "accepted";
      } catch { return false; }
    }).length;
    const out = {
      schema_version: 1,
      step: latest.step,
      actor: latest.actor,
      action: latest.action,
      status: latest.status,
      history_count: files.length,
      accepted_count: accepted,
      rejected_count: files.length - accepted,
      strategies: snow.strategies ?? null,
      declined_strategies: snow.declined_strategies ?? [],
      best_aggregate: snow.best_scoring?.weighted_aggregate ?? null,
      best_color_tier: snow.best_scoring?.color_tier ?? null,
      best_scorecards: snow.best_scoring?.scorecards ?? [],
      aggregate_history: snow.aggregate_history ?? [],
      pending_summon: snow.pending_summon ?? null,
      draft_chars: (snow.best_draft ?? snow.draft).length,
      critique_count: snow.critique_trail?.length ?? 0,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return;
  }

  const snowball = latest.snowball;
  const draft_for_count = snowball.best_draft ?? snowball.draft;
  const word_count = draft_for_count.split(/\s+/).length;
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

  // strategies panel (phase 1 of #42)
  const strategies = snowball.strategies;
  const configured = strategies ? Object.keys(strategies) : [];
  if (configured.length > 0) {
    log(`strategies: ${configured.join(", ")}`);
    if (strategies?.rubric) {
      const dims = strategies.rubric.dimensions.map((d: any) => d.name).join(", ");
      log(`  rubric:     ${strategies.rubric.dimensions.length} dims (${dims})`);
    }
    if (strategies?.color) {
      log(`  color:      ${strategies.color.question}`);
    }
  }
  // declined strategies — captured at init, surfaced here so operators
  // can see WHICH strategies opted out and why (#50).
  const declined = snowball.declined_strategies ?? [];
  if (declined.length > 0) {
    log(`declined:   ${declined.map((d) => d.name).join(", ")}`);
    for (const d of declined) {
      log(`  ${d.name}: ${d.rationale.slice(0, 200)}`);
    }
  }
  const best = snowball.best_scoring;
  if (best) {
    log(`best:       aggregate=${best.weighted_aggregate.toFixed(3)}${best.color_tier ? ` tier=${best.color_tier}` : ""}`);
  }
  const history = snowball.aggregate_history ?? [];
  if (history.length > 0) {
    const trajectory = history.map((n: number) => n.toFixed(2)).join(" → ");
    log(`trajectory: ${trajectory}`);
    // sparkline below the numeric trajectory (#53)
    if (history.length > 1) {
      log(`            ${sparkline(history)}`);
    }
  }

  log(`draft:      ${word_count} words, ${draft_for_count.length} chars`);
  log(`trail:      ${snowball.critique_trail.length} critiques`);
  log(`decisions:  ${snowball.resolved_decisions.length} compacted`);
  log(`directives: ${snowball.human_directives.length} human`);
}

// --- joust export ---

export function export_draft(dir: string, opts: { json?: boolean } = {}): void {
  dir = resolve(dir);
  set_log_dir(dir);
  const latest = read_latest_history(dir);

  if (!latest) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ error: "no history found", dir }) + "\n");
      return;
    }
    throw new JoustUserError("no history found — run 'joust /init' first");
  }

  // phase 1 of #42: emit best_draft when strategy scoring tracked it;
  // fall back to current draft for legacy runs that never scored.
  const out = latest.snowball.best_draft ?? latest.snowball.draft;

  // machine-readable form (#60). bundles the draft + structured scoring
  // so a skill can render scores in conversation without re-running
  // /status. schema_version pins the contract.
  if (opts.json) {
    const snow: any = latest.snowball;
    const payload = {
      schema_version: 1,
      draft: out,
      best_aggregate: snow.best_scoring?.weighted_aggregate ?? null,
      best_color_tier: snow.best_scoring?.color_tier ?? null,
      scorecards: snow.best_scoring?.scorecards ?? [],
      strategies: snow.strategies ?? null,
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }

  write_stdout(out);
}

// --- joust diff ---

export function diff(dir: string, step1?: string, step2?: string): void {
  dir = resolve(dir);
  const files = scan_history(dir);

  if (files.length < 2 && !(step1 && step2)) {
    log("need at least 2 history entries for diff (or specify two step numbers)");
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

  // per-dim score deltas (#53). only emit when both entries have scoring;
  // legacy / pre-strategy entries fall through to text-only diff.
  const sa = entry_a.snowball.best_scoring;
  const sb = entry_b.snowball.best_scoring;
  if (sa && sb) {
    log("");
    log("=== scores ===");
    if (sa.color_tier !== sb.color_tier) {
      log(`color_tier: ${sa.color_tier ?? "(none)"} → ${sb.color_tier ?? "(none)"}`);
    }
    log(
      `aggregate:  ${sa.weighted_aggregate.toFixed(3)} → ${sb.weighted_aggregate.toFixed(3)}`
    );
    const a_by_strategy = new Map(sa.scorecards.map((c: any) => [c.strategy, c]));
    for (const cb of sb.scorecards) {
      const ca = a_by_strategy.get(cb.strategy);
      if (!ca) {
        log(`strategy: ${cb.strategy} (new in step ${entry_b.step})`);
        continue;
      }
      log("");
      log(`strategy: ${cb.strategy}`);
      const a_dims = new Map(ca.dimensions.map((d: any) => [d.name, d]));
      for (const db of cb.dimensions) {
        const da = a_dims.get(db.name);
        if (!da) {
          log(`  ${db.name}: (new) → ${db.score}`);
          continue;
        }
        if (da.score === db.score) continue;
        const arrow = db.score > da.score ? "↑" : "↓";
        log(`  ${db.name}: ${da.score} → ${db.score} ${arrow}`);
      }
      const agg_a = ca.aggregate;
      const agg_b = cb.aggregate;
      log(`  aggregate: ${agg_a.toFixed(3)} → ${agg_b.toFixed(3)}`);
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
  const draft_chars = latest
    ? (latest.snowball.best_draft?.length ?? latest.snowball.draft.length)
    : 5000;
  const draft_tokens = Math.ceil(draft_chars / 4);

  // N scoring passes per mutation, where N = configured strategy count
  // (phase 1 of #42). legacy/unbootstrapped runs fall back to 1 (the
  // old single-lint pass).
  const strategy_count = Math.max(
    1,
    Object.keys(latest?.snowball.strategies ?? {}).length
  );

  const context_overhead = 2000; // tokens for system prompt, invariants, trail summary
  const tokens_per_call = draft_tokens + context_overhead;

  // per jouster: 1 mutation + lint + strategy_count scoring calls
  // per round: 1 polish + lint + strategy_count scoring calls
  const jouster_calls_per_round = jousters.length * (1 + 1 + strategy_count);
  const polish_calls_per_round = 1 + 1 + strategy_count;
  const calls_per_round = jouster_calls_per_round + polish_calls_per_round;
  const total_calls = calls_per_round * max_rounds;
  const total_input_tokens = total_calls * tokens_per_call;
  const total_output_tokens = Math.ceil(total_input_tokens * 0.5);

  // when scorer_model is configured, scoring calls go to the cheaper model;
  // bootstrap + lint + polish stay on main. count them separately.
  const scorer_model_id = config.defaults.scorer_model;
  const scorer_overridden = !!scorer_model_id && scorer_model_id !== main.model;
  const scorer_label = scorer_overridden ? scorer_model_id! : main.model;

  log(`=== joust plan ===`);
  log(`agents: main (${main.model}) + ${jousters.length} jousters`);
  for (const j of jousters) {
    log(`  - ${j.name} (${j.model})`);
  }
  if (scorer_overridden) {
    log(`scorer: ${scorer_label} (cheap-scorer override; bootstrap stays on ${main.model})`);
    log(`  note: cheaper scoring is also noisier — unset scorer_model for the final pre-publication run.`);
  }
  log(`strategies: ${strategy_count} (${Object.keys(latest?.snowball.strategies ?? {}).join(", ") || "(legacy/none)"})`);
  log(`rounds: ${max_rounds} | retries: ${max_retries}/agent`);
  log(`draft:  ~${draft_tokens} tokens (${draft_chars} chars)`);
  log(`calls:  ~${total_calls} API calls (${calls_per_round}/round)`);
  log(`tokens: ~${Math.round(total_input_tokens / 1000)}K input, ~${Math.round(total_output_tokens / 1000)}K output`);
  log(``);

  // cost breakdown by model. main does lint + polish; scorer (= main when
  // scorer_model unset) handles strategy scoring calls.
  const model_usage: Record<string, { input: number; output: number }> = {};
  // main: 1 lint per jouster mutation + 1 lint per polish + 1 polish call = (jousters + 2) per round
  const main_lint_polish_calls = (jousters.length + 2) * max_rounds;
  // scorer: strategy_count score calls per jouster + strategy_count per polish
  const scorer_calls = (jousters.length + 1) * strategy_count * max_rounds;

  const main_key = main.model;
  model_usage[main_key] = {
    input: (model_usage[main_key]?.input ?? 0) + main_lint_polish_calls * tokens_per_call,
    output: (model_usage[main_key]?.output ?? 0) + main_lint_polish_calls * Math.ceil(tokens_per_call * 0.3),
  };
  // scorer is either same model as main (merge) or a separate row.
  const scorer_key = scorer_label;
  if (scorer_key === main_key) {
    model_usage[main_key] = {
      input: (model_usage[main_key]?.input ?? 0) + scorer_calls * tokens_per_call,
      output: (model_usage[main_key]?.output ?? 0) + scorer_calls * Math.ceil(tokens_per_call * 0.3),
    };
  } else {
    model_usage[scorer_key] = {
      input: (model_usage[scorer_key]?.input ?? 0) + scorer_calls * tokens_per_call,
      output: (model_usage[scorer_key]?.output ?? 0) + scorer_calls * Math.ceil(tokens_per_call * 0.3),
    };
  }
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
  if (config.defaults.workspace) {
    log(`note: workspace is set — agents will use tools to read files, increasing token usage.`);
  }
}

// --- joust ask ---

export async function ask(dir: string, agent_name: string, question: string): Promise<void> {
  dir = resolve(dir);
  set_log_dir(dir);
  const config = resolve_config(dir);
  const all_agents = config.agents;
  const agent = all_agents[agent_name];

  if (!agent) {
    throw new JoustUserError(`agent '${agent_name}' not found. available: ${Object.keys(all_agents).join(", ")}`);
  }

  const latest = read_latest_history(dir);
  if (!latest) {
    throw new JoustUserError("no history found — run 'joust init' first");
  }

  const snowball = latest.snowball;
  const workspace = config.defaults.workspace;
  const workspace_tools = workspace ? create_workspace_tools(workspace) : undefined;

  const messages = compile_context(agent, snowball, "ask", {
    has_tools: !!workspace_tools,
  });

  // append the user's question after the draft context
  messages.push({
    role: "user",
    content: question,
  });

  const response = await call_agent(agent, messages, {
    tools: workspace_tools,
    max_tool_steps: config.defaults.max_tool_steps,
    log_dir: join(dir, "logs"),
    log_label: `ask: ${question.slice(0, 120)}`,
  });
  write_stdout(response);
}
