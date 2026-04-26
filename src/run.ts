import { resolve, join } from "path";
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { call_agent_structured } from "./ai";
import type { ToolSet } from "ai";
import { compile_context } from "./context";
import {
  resolve_config,
  get_main_agent,
  get_jousters,
  is_specialist_name,
  build_specialist_agent,
  build_scorer_agent,
  preset_peer_pick,
  detect_preset,
} from "./config";
import { create_workspace_tools } from "./tools";
import { lint_mutation, score_draft, compare_results } from "./lint";
import { maybe_compact } from "./compact";
import { tank_execute, parse_duration, is_timeboxed_out } from "./tank";
import {
  read_latest_history,
  next_step_number,
  commit_state,
  acquire_lock,
  release_lock,
  log,
  log_status,
  log_header,
  log_success,
  log_warn,
  log_error,
  to_json,
  append_log,
  set_log_dir,
  write_stdout,
} from "./utils";
import {
  MutationResultSchema,
  type Snowball,
  type HistoryEntry,
  type CritiqueEntry,
  type ScoringResult,
  type StrategiesConfig,
  type AgentConfig,
} from "./types";

// --- orphan .tmp cleanup ---

function cleanup_tmp_files(dir: string): void {
  const dirs_to_clean = [dir, join(dir, "history")];
  for (const d of dirs_to_clean) {
    try {
      for (const f of readdirSync(d)) {
        if (f.endsWith(".tmp")) {
          try { unlinkSync(join(d, f)); } catch {}
        }
      }
    } catch {}
  }
}

// --- strategy scoring helpers (phase 1 of #42) ---

// fallback values when config doesn't supply them. real values come from
// JoustDefaults.plateau_epsilon / plateau_k, plumbed in from resolve_config.
const DEFAULT_PLATEAU_EPSILON = 0.02;
const DEFAULT_PLATEAU_K = 2;

// a plateau is k+1 consecutive aggregates with no improvement > epsilon.
// cheap to detect, no LLM calls.
function is_plateau(history: number[], epsilon: number, k: number): boolean {
  if (history.length < k + 1) return false;
  const recent = history.slice(-k - 1);
  const peak = recent[0]!;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i]! - peak > epsilon) return false;
  }
  return true;
}

// legacy entries lack `strategies`/`best_*`. derive strategies.invariants
// from the top-level legacy invariants so existing runs resume without
// re-bootstrap. best_draft starts as the current draft.
function migrate_snowball(snow: Snowball): Snowball {
  if (snow.strategies) return snow;

  const inv = snow.invariants;
  const has_rules = inv.MUST.length + inv.SHOULD.length + inv.MUST_NOT.length > 0;
  const strategies: StrategiesConfig = has_rules
    ? { invariants: { MUST: inv.MUST, SHOULD: inv.SHOULD, MUST_NOT: inv.MUST_NOT } }
    : {};

  return {
    ...snow,
    strategies,
    best_draft: snow.draft,
    best_scoring: undefined,
    aggregate_history: [],
  };
}

// score a candidate via the configured strategies. returns null on
// failure (network/parse errors) so the caller can fall back to legacy
// lint-only semantics.
//
// the `scorer` arg is the agent to run strategy score() calls against.
// it's main when defaults.scorer_model is unset; otherwise a cloned
// main with the model swapped (#51). we never use this for bootstrap.
async function score_candidate(
  scorer: AgentConfig,
  strategies: StrategiesConfig,
  snowball: Snowball,
  candidate_draft: string,
  options: {
    signal?: AbortSignal;
    tools?: ToolSet;
    max_tool_steps?: number;
    log_dir?: string;
    log_label?: string;
    tank?: boolean;
  }
): Promise<ScoringResult | null> {
  const run = async () =>
    score_draft(scorer, strategies, snowball, candidate_draft, {
      signal: options.signal,
      tools: options.tools,
      max_tool_steps: options.max_tool_steps,
      log_dir: options.log_dir,
      log_label: options.log_label,
    });
  if (options.tank) {
    return await tank_execute(scorer.name, run);
  }
  try {
    return await run();
  } catch (err: any) {
    log_status(scorer.name, `scoring error: ${err.message}`);
    return null;
  }
}

// --- visibility helpers (#50) ---
//
// when polish scores below current best, emit a multi-line log block that
// shows the per-strategy aggregate delta, color-tier change if any, and
// the top-2 dim regressions. operator can see *why* the polish was
// dropped without spelunking through history.
function log_polish_regression(
  prev: ScoringResult,
  curr: ScoringResult
): void {
  const lines: string[] = [];
  lines.push(
    `[main] polish regressed: agg ${prev.weighted_aggregate.toFixed(3)} → ${curr.weighted_aggregate.toFixed(3)} (kept previous best)`
  );

  if (prev.color_tier !== curr.color_tier) {
    lines.push(`  color: ${prev.color_tier ?? "(none)"} → ${curr.color_tier ?? "(none)"}`);
  }

  // per-strategy aggregate delta
  const prev_by_name = new Map(prev.scorecards.map((c) => [c.strategy, c]));
  for (const cur of curr.scorecards) {
    const p = prev_by_name.get(cur.strategy);
    if (!p) continue;
    if (Math.abs(cur.aggregate - p.aggregate) < 0.001) continue;
    lines.push(
      `  ${cur.strategy}: ${p.aggregate.toFixed(3)} → ${cur.aggregate.toFixed(3)}`
    );
  }

  // top-2 individual dim regressions across all strategies
  type Drop = { strategy: string; dim: string; before: number; after: number; rationale: string };
  const drops: Drop[] = [];
  for (const cur of curr.scorecards) {
    const p = prev_by_name.get(cur.strategy);
    if (!p) continue;
    const p_dims = new Map(p.dimensions.map((d) => [d.name, d]));
    for (const d of cur.dimensions) {
      const pd = p_dims.get(d.name);
      if (!pd) continue;
      if (d.score < pd.score) {
        drops.push({
          strategy: cur.strategy,
          dim: d.name,
          before: pd.score,
          after: d.score,
          rationale: d.rationale,
        });
      }
    }
  }
  drops.sort((a, b) => b.before - b.after - (a.before - a.after));
  for (const d of drops.slice(0, 2)) {
    lines.push(`  - ${d.strategy}/${d.dim}: ${d.before} → ${d.after} (${d.rationale.slice(0, 100)})`);
  }

  for (const l of lines) log(l);
}

// summon carryover log point — placeholder for #52. wired now so the
// downstream issue can fill in real state without a second touchup of
// this code path.
function log_summon_carryover(round: number, snowball: Snowball): void {
  const pending = (snowball as any).pending_summon;
  if (!pending) return;
  log(
    `[round ${round}] carrying over: ${pending.specialist} specialist asked "${(pending.ask ?? "").slice(0, 80)}", prior attempt rejected for: ${(pending.last_rejection ?? "(no rejection captured)").slice(0, 100)}`
  );
}

// --- options ---

export interface RunOptions {
  tank?: boolean;
  timebox?: string;    // e.g., "45m", "1h"
  timeout?: string;    // hard limit
  interactive?: number; // pause every N rounds
}

// --- interactive intermission ---

async function human_intermission(snowball: Snowball, round: number): Promise<string | null> {
  const editor = process.env.EDITOR || "vi";
  const tmp_file = join(tmpdir(), `joust-feedback-${Date.now()}.md`);

  const word_count = snowball.draft.split(/\s+/).length;
  const must_count = snowball.invariants.MUST.length;
  const should_count = snowball.invariants.SHOULD.length;
  const must_not_count = snowball.invariants.MUST_NOT.length;
  const trail_count = snowball.critique_trail.length;

  const recent = snowball.critique_trail.slice(-3);
  const recent_text = recent
    .map((c) => `  [${c.actor}] ${c.action}: ${c.notes.slice(0, 120)}`)
    .join("\n");

  const buffer = [
    `# joust intermission — round ${round}`,
    `# ${word_count} words | ${must_count} MUST | ${should_count} SHOULD | ${must_not_count} MUST NOT | ${trail_count} critiques`,
    `#`,
    `# recent activity:`,
    ...recent.map((c) => `#   [${c.actor}] ${c.notes.slice(0, 100)}`),
    `#`,
    `# write your feedback below. lines starting with # are ignored.`,
    `# save and exit to continue. empty feedback = no directive.`,
    ``,
    ``,
  ].join("\n");

  await Bun.write(tmp_file, buffer);

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

  return lines || null;
}

// --- the accumulator loop ---

export async function run(dir: string, options: RunOptions = {}): Promise<void> {
  dir = resolve(dir);
  acquire_lock(dir);
  set_log_dir(dir);

  // resume: read latest state
  const latest = read_latest_history(dir);
  if (!latest) {
    throw new Error(`no history found in ${dir}/history/ — run 'joust init' first`);
  }

  let snowball = migrate_snowball(latest.snowball);
  let step = next_step_number(dir);
  const strategies = snowball.strategies ?? {};
  const strategy_names = Object.keys(strategies);

  log(`\nresuming from step ${latest.step} (${latest.actor}/${latest.action})`);
  log(`draft: ${snowball.draft.length} chars`);
  log(`invariants: ${snowball.invariants.MUST.length} MUST, ${snowball.invariants.SHOULD.length} SHOULD, ${snowball.invariants.MUST_NOT.length} MUST NOT`);
  if (strategy_names.length > 0) {
    log(`strategies: ${strategy_names.join(", ")}`);
  }
  log("");

  // timebox setup
  const start_time = Date.now();
  const timebox_ms = options.timebox ? parse_duration(options.timebox) : null;
  const timeout_ms = options.timeout ? parse_duration(options.timeout) : null;
  // always create an abort controller — signals need it even without --timeout
  const abort_controller = new AbortController();

  const timeout_id = timeout_ms
    ? setTimeout(() => abort_controller.abort("hard timeout reached"), timeout_ms)
    : null;

  // signal handling: wire SIGINT/SIGTERM to abort + cleanup
  let signal_received = false;
  const signal_handler = (sig: string) => {
    if (signal_received) {
      // second signal = force exit
      log(`\n${sig} received again, forcing exit`);
      process.exit(128 + (sig === "SIGINT" ? 2 : 15));
    }
    signal_received = true;
    log(`\n${sig} received, shutting down gracefully...`);
    abort_controller.abort(`${sig} received`);
  };
  process.on("SIGINT", () => signal_handler("SIGINT"));
  process.on("SIGTERM", () => signal_handler("SIGTERM"));

  // re-read config at round boundary
  let config = resolve_config(dir);
  let main = get_main_agent(config);
  let scorer = build_scorer_agent(main, config.defaults.scorer_model);
  let jousters = get_jousters(config);
  const max_retries = config.defaults.max_retries;
  const max_rounds = config.defaults.max_rounds;
  const plateau_epsilon = config.defaults.plateau_epsilon ?? DEFAULT_PLATEAU_EPSILON;
  const plateau_k = config.defaults.plateau_k ?? DEFAULT_PLATEAU_K;
  const interactive_interval = options.interactive ?? 0;
  let workspace_tools: ToolSet | undefined;
  let max_tool_steps: number | undefined;
  if (config.defaults.workspace) {
    workspace_tools = create_workspace_tools(config.defaults.workspace);
    max_tool_steps = config.defaults.max_tool_steps;
    log(`workspace: ${config.defaults.workspace} (agents have file access)`);
  }
  if (scorer !== main) {
    log(`scorer: ${scorer.model} (cheap-scorer override; bootstrap stays on ${main.model})`);
  }

  try {
  for (let round = 1; round <= max_rounds; round++) {
    // check signal at round boundary
    if (signal_received) {
      log(`\nexiting after signal`);
      break;
    }

    // check timebox at round boundary
    if (timebox_ms && is_timeboxed_out(start_time, timebox_ms)) {
      log(`\ntimebox reached after ${Math.round((Date.now() - start_time) / 1000)}s`);
      break;
    }

    // re-read config at round boundary (supports mid-flight edits)
    config = resolve_config(dir);
    main = get_main_agent(config);
    scorer = build_scorer_agent(main, config.defaults.scorer_model);
    jousters = get_jousters(config);
    if (config.defaults.workspace) {
      workspace_tools = create_workspace_tools(config.defaults.workspace);
      max_tool_steps = config.defaults.max_tool_steps;
    } else {
      workspace_tools = undefined;
      max_tool_steps = undefined;
    }

    log_header(`=== round ${round}/${max_rounds} ===`);

    // cap: one summon per round across all peers. prevents specialist cascades
    // and keeps runs predictable. either peer can summon; first-write-wins.
    const MAX_SUMMONS_PER_ROUND = 1;
    let summons_this_round = 0;

    // peer_pick: the "second company" model, used as the default provider for
    // ad-hoc summoned specialists that aren't pinned in rfc.yaml.
    const peer_pick = preset_peer_pick(detect_preset());

    for (const jouster of jousters) {
      // check signal before each agent
      if (signal_received) break;

      // check timebox before each agent
      if (timebox_ms && is_timeboxed_out(start_time, timebox_ms)) {
        log_warn(`timebox reached, pausing before ${jouster.name}`);
        break;
      }

      log_status(jouster.name, "mutating draft...");

      let accepted = false;
      let attempts = 0;
      let last_violations: string[] = [];

      while (!accepted && attempts < max_retries) {
        attempts++;

        const execute_mutation = async () => {
          // compile context for jouster
          const messages = compile_context(jouster, snowball, "jouster", {
            has_tools: !!workspace_tools,
          });

          // if retrying, append rejection feedback
          if (last_violations.length > 0) {
            messages.push({
              role: "user",
              content: [
                "YOUR PREVIOUS ATTEMPT WAS REJECTED for the following violations:",
                ...last_violations.map((v) => `  - ${v}`),
                "",
                "Rewrite your mutation to comply with the invariants.",
              ].join("\n"),
            });
          }

          // call the jouster
          const signal = abort_controller.signal;
          return await call_agent_structured(jouster, messages, MutationResultSchema, {
            signal,
            tools: workspace_tools,
            max_tool_steps,
            log_dir: join(dir, "logs"),
            log_label: `round ${round} step ${step} attempt ${attempts}`,
          });
        };

        try {
          // mutation and lint are wrapped independently so a transient lint failure
          // doesn't discard a successful (expensive) mutation
          let mutation;
          if (options.tank) {
            mutation = await tank_execute(jouster.name, execute_mutation);
            if (!mutation) {
              log_status(jouster.name, "skipped (tank mode: agent unavailable)");
              append_log(dir, "execution.log", `\n--- ${new Date().toISOString()} ---\n${jouster.name} SYSTEM_FAILURE: skipped by tank mode\n`);
              break;
            }
          } else {
            mutation = await execute_mutation();
          }

          const execute_lint = async () => lint_mutation(main, snowball, mutation!.draft, {
            tools: workspace_tools,
            max_tool_steps,
            log_dir: join(dir, "logs"),
            log_label: `round ${round} step ${step} lint (by main, target ${jouster.name})`,
          });
          let lint;
          if (options.tank) {
            lint = await tank_execute("main", execute_lint);
            if (!lint) {
              log_status("main", "lint unavailable (tank mode), accepting mutation");
              lint = { valid: true, violations: [] };
            }
          } else {
            lint = await execute_lint();
          }

          // strategy scoring gate — runs only when strategies are
          // configured. for legacy runs (empty strategies), score_draft
          // returns aggregate=1.0 and best never regresses, so semantics
          // match the pre-strategy behavior.
          let scoring: ScoringResult | null = null;
          if (lint.valid && strategy_names.length > 0) {
            scoring = await score_candidate(
              scorer,
              strategies,
              snowball,
              mutation.draft,
              {
                signal: abort_controller.signal,
                tools: workspace_tools,
                max_tool_steps,
                log_dir: join(dir, "logs"),
                log_label: `round ${round} step ${step} score (${jouster.name})`,
                tank: options.tank,
              }
            );
          }

          // if strategies say no (floor violation) OR no-improvement-vs-best,
          // mark the mutation as rejected. lint-only legacy runs skip this.
          let strategy_rejected = false;
          if (scoring) {
            if (!scoring.passed) {
              strategy_rejected = true;
              const reasons = scoring.floor_violations.map(
                (v) => `${v.strategy}/${v.dimension}: ${v.rationale}`
              );
              lint = { valid: false, violations: reasons };
            } else if (snowball.best_scoring && compare_results(scoring, snowball.best_scoring) < 0) {
              strategy_rejected = true;
              const best = snowball.best_scoring;
              const reason = `no improvement vs best (agg=${scoring.weighted_aggregate.toFixed(3)} vs best=${best.weighted_aggregate.toFixed(3)}${scoring.color_tier ? ` tier=${scoring.color_tier}` : ""})`;
              lint = { valid: false, violations: [reason] };
            }
          }

          if (lint.valid) {
            // accept the mutation
            const critique_entry: CritiqueEntry = {
              actor: jouster.name,
              action: "mutated_draft",
              notes: mutation.critique,
              timestamp: new Date().toISOString(),
            };

            snowball = {
              ...snowball,
              draft: mutation.draft,
              critique_trail: [...snowball.critique_trail, critique_entry],
              // scoring-aware best-so-far tracking. when scoring succeeded
              // and the candidate equaled-or-beat the best, promote it.
              // otherwise preserve the existing best_draft/best_scoring.
              best_draft: scoring ? mutation.draft : snowball.best_draft,
              best_scoring: scoring ?? snowball.best_scoring,
            };

            const entry: HistoryEntry = {
              step,
              actor: jouster.name,
              action: "mutation",
              status: "accepted",
              timestamp: new Date().toISOString(),
              snowball,
            };

            commit_state(dir, step, jouster.name, entry);
            step++;
            accepted = true;

            const score_label = scoring
              ? ` agg=${scoring.weighted_aggregate.toFixed(3)}${scoring.color_tier ? ` tier=${scoring.color_tier}` : ""}`
              : "";
            log_success(`[${jouster.name}] accepted (attempt ${attempts}${score_label})`);

            // --- summon a specialist if requested ---
            // only non-specialist agents (main/peer) can summon; specialists
            // cannot recursively summon other specialists. one summon per round.
            if (
              mutation.summon &&
              !is_specialist_name(jouster.name) &&
              summons_this_round < MAX_SUMMONS_PER_ROUND &&
              !signal_received
            ) {
              const specialist_name = mutation.summon.specialist;
              const ask = mutation.summon.ask;
              summons_this_round++;

              log_status(jouster.name, `summoning ${specialist_name}: ${ask.slice(0, 120)}`);

              try {
                const specialist_agent = build_specialist_agent(
                  specialist_name,
                  ask,
                  config,
                  peer_pick
                );

                const spec_messages = compile_context(
                  specialist_agent,
                  snowball,
                  "specialist",
                  { has_tools: !!workspace_tools }
                );

                const spec_mutation = await call_agent_structured(
                  specialist_agent,
                  spec_messages,
                  MutationResultSchema,
                  {
                    signal: abort_controller.signal,
                    tools: workspace_tools,
                    max_tool_steps,
                    log_dir: join(dir, "logs"),
                    log_label: `round ${round} step ${step} summoned by ${jouster.name} — ask: ${ask.slice(0, 120)}`,
                  }
                );

                const spec_lint = await lint_mutation(main, snowball, spec_mutation.draft, {
                  tools: workspace_tools,
                  max_tool_steps,
                  log_dir: join(dir, "logs"),
                  log_label: `round ${round} step ${step} lint (specialist ${specialist_name})`,
                });

                if (spec_lint.valid) {
                  const spec_critique: CritiqueEntry = {
                    actor: specialist_name,
                    action: `summoned_by_${jouster.name}`,
                    notes: `ask: ${ask}\n\n${spec_mutation.critique}`,
                    timestamp: new Date().toISOString(),
                  };

                  snowball = {
                    ...snowball,
                    draft: spec_mutation.draft,
                    critique_trail: [...snowball.critique_trail, spec_critique],
                  };

                  const spec_entry: HistoryEntry = {
                    step,
                    actor: specialist_name,
                    action: `summoned_by_${jouster.name}`,
                    status: "accepted",
                    timestamp: new Date().toISOString(),
                    snowball,
                  };
                  commit_state(dir, step, specialist_name, spec_entry);
                  step++;
                  log_success(`[${specialist_name}] accepted (summoned by ${jouster.name})`);
                } else {
                  const spec_entry: HistoryEntry = {
                    step,
                    actor: specialist_name,
                    action: `summoned_by_${jouster.name}`,
                    status: "rejected",
                    timestamp: new Date().toISOString(),
                    snowball: { ...snowball, draft: spec_mutation.draft },
                    violations: spec_lint.violations,
                  };
                  commit_state(dir, step, specialist_name, spec_entry);
                  step++;
                  log_warn(`[${specialist_name}] rejected — violations: ${spec_lint.violations.join("; ")}`);
                }
              } catch (err: any) {
                if (err.name === "AbortError" || signal_received) {
                  log_status(specialist_name, "aborted");
                } else {
                  const err_detail = err.message || err.cause?.message || String(err);
                  log_error(`[${specialist_name}] summon error: ${err_detail}`);
                  append_log(
                    dir,
                    "execution.log",
                    `\n--- ${new Date().toISOString()} ---\n${specialist_name} summon error: ${err_detail}\n`
                  );
                }
              }
            } else if (
              mutation.summon &&
              !is_specialist_name(jouster.name) &&
              summons_this_round >= MAX_SUMMONS_PER_ROUND
            ) {
              log_warn(
                `[${jouster.name}] summon for ${mutation.summon.specialist} deferred (round cap reached)`
              );
            }
          } else {
            // rejected — save the rejection and retry
            last_violations = lint.violations;

            const entry: HistoryEntry = {
              step,
              actor: jouster.name,
              action: "mutation",
              status: "rejected",
              timestamp: new Date().toISOString(),
              snowball: { ...snowball, draft: mutation.draft },
              violations: lint.violations,
            };

            commit_state(dir, step, jouster.name, entry);
            step++;

            log_warn(`[${jouster.name}] rejected (attempt ${attempts}/${max_retries})`);
          }
        } catch (err: any) {
          if (err.name === "AbortError" || signal_received) {
            log_status(jouster.name, signal_received ? "aborted by signal" : "aborted by timeout");
            const entry: HistoryEntry = {
              step,
              actor: jouster.name,
              action: "mutation",
              status: "aborted",
              timestamp: new Date().toISOString(),
              snowball,
            };
            commit_state(dir, step, jouster.name, entry);
            step++;
            break;
          }

          const err_detail = err.message || err.cause?.message || String(err);
          log_error(`[${jouster.name}] error: ${err_detail}`);
          append_log(dir, "execution.log", `\n--- ${new Date().toISOString()} ---\n${jouster.name} error: ${err_detail}\n`);
        }
      }

      if (!accepted && !signal_received) {
        log_warn(`[${jouster.name}] skipped after ${max_retries} failed attempts`);
        append_log(dir, "execution.log", `\n--- ${new Date().toISOString()} ---\n${jouster.name} exhausted retries, skipping\n`);

        // circuit breaker: signal that intervention may be needed
        if (interactive_interval > 0) {
          log(`\n--- circuit breaker: ${jouster.name} exhausted retries ---\n`);
          const feedback = await human_intermission(snowball, round);
          if (feedback) {
            snowball = {
              ...snowball,
              human_directives: [...snowball.human_directives, feedback],
            };
            log(`human directive recorded (${feedback.length} chars)`);
          }
        } else {
          // non-interactive: write marker file
          const marker_path = join(dir, ".needs-attention");
          const marker = `${jouster.name} exhausted ${max_retries} retries at step ${step}, round ${round}.\n` +
            `Last violations: ${last_violations.join("; ")}\n` +
            `Timestamp: ${new Date().toISOString()}\n`;
          try { writeFileSync(marker_path, marker); } catch {}
          log(`[warn] wrote ${marker_path} — ${jouster.name} needs attention`);
        }
      }
    }

    // bail immediately on signal
    if (signal_received) break;

    // compaction check before polish
    try {
      const compaction_threshold = config.defaults.compaction_threshold;
      const compact_fn = async () => maybe_compact(
        main, snowball, compaction_threshold, {
          signal: abort_controller.signal,
          tools: workspace_tools,
          max_tool_steps,
          log_dir: join(dir, "logs"),
          log_label: `round ${round} compact`,
        }
      );
      const compacted = options.tank
        ? await tank_execute("main", compact_fn)
        : await compact_fn();
      if (compacted && compacted !== snowball) {
        snowball = compacted;
        const entry: HistoryEntry = {
          step,
          actor: "main",
          action: "compact",
          status: "accepted",
          timestamp: new Date().toISOString(),
          snowball,
        };
        commit_state(dir, step, "main", entry);
        step++;
      }
    } catch (err: any) {
      if (!signal_received) log_error(`[main] compaction error: ${err.message}`);
    }

    // bail immediately on signal
    if (signal_received) break;

    // main polish at end of round
    log_status("main", "polishing draft...");

    try {
      const polish_fn = async () => {
        const polish_messages = compile_context(main, snowball, "polish", {
          has_tools: !!workspace_tools,
        });
        return await call_agent_structured(main, polish_messages, MutationResultSchema, {
          signal: abort_controller.signal,
          tools: workspace_tools,
          max_tool_steps,
          log_dir: join(dir, "logs"),
          log_label: `round ${round} polish`,
        });
      };

      const polish = options.tank ? await tank_execute("main", polish_fn) : await polish_fn();

      if (polish) {
        // lint the polish pass — warn but don't reject (main is trusted)
        try {
          const polish_lint = await lint_mutation(main, snowball, polish.draft, {
            tools: workspace_tools,
            max_tool_steps,
            log_dir: join(dir, "logs"),
            log_label: `round ${round} polish lint`,
          });
          if (!polish_lint.valid) {
            log_warn(`[main] polish violated invariants: ${polish_lint.violations.join("; ")}`);
          }
        } catch {
          // lint failure during polish is non-fatal
        }

        // strategy-score the polish. legacy (no strategies) → scoring is
        // null and polish is always accepted as best_draft unchanged —
        // matches pre-strategy behavior. with strategies, a regressing
        // polish still writes the critique trail but does NOT overwrite
        // best_draft/best_scoring.
        let polish_scoring: ScoringResult | null = null;
        if (strategy_names.length > 0) {
          polish_scoring = await score_candidate(
            scorer,
            strategies,
            snowball,
            polish.draft,
            {
              signal: abort_controller.signal,
              tools: workspace_tools,
              max_tool_steps,
              log_dir: join(dir, "logs"),
              log_label: `round ${round} polish score`,
              tank: options.tank,
            }
          );
        }

        const polish_is_best =
          polish_scoring &&
          polish_scoring.passed &&
          (snowball.best_scoring ? compare_results(polish_scoring, snowball.best_scoring) >= 0 : true);

        const critique_entry: CritiqueEntry = {
          actor: "main",
          action: "polish",
          notes: polish.critique,
          timestamp: new Date().toISOString(),
        };

        snowball = {
          ...snowball,
          draft: polish.draft,
          critique_trail: [...snowball.critique_trail, critique_entry],
          best_draft: polish_is_best ? polish.draft : snowball.best_draft,
          best_scoring: polish_is_best ? polish_scoring! : snowball.best_scoring,
        };

        const entry: HistoryEntry = {
          step,
          actor: "main",
          action: "polish",
          status: "accepted",
          timestamp: new Date().toISOString(),
          snowball,
        };

        commit_state(dir, step, "main", entry);
        step++;

        if (polish_scoring) {
          const score_label = `agg=${polish_scoring.weighted_aggregate.toFixed(3)}${polish_scoring.color_tier ? ` tier=${polish_scoring.color_tier}` : ""}`;
          if (polish_is_best) {
            log_status("main", `polish complete (${score_label}, new best)`);
          } else if (snowball.best_scoring) {
            // emit a richer regression block instead of the bare one-liner
            log_polish_regression(snowball.best_scoring, polish_scoring);
          } else {
            log_status("main", `polish complete (${score_label}, kept previous best)`);
          }
        } else {
          log_status("main", "polish complete");
        }
      }
    } catch (err: any) {
      if (!signal_received) log_error(`[main] polish error: ${err.message}`);
    }

    // plateau detection — phase 1 of #42. when strategies are configured
    // and the best_scoring aggregate hasn't improved across the last K+1
    // rounds, end the run early. legacy runs (no scoring) skip this.
    let plateaued = false;
    if (strategy_names.length > 0 && snowball.best_scoring) {
      const hist = [
        ...(snowball.aggregate_history ?? []),
        snowball.best_scoring.weighted_aggregate,
      ];
      snowball = { ...snowball, aggregate_history: hist };
      if (is_plateau(hist, plateau_epsilon, plateau_k)) {
        plateaued = true;
        log(`\nplateau detected (${plateau_k} rounds without improvement of > ${plateau_epsilon}), ending run`);
      }
    }

    // interactive pause
    if (interactive_interval > 0 && round % interactive_interval === 0 && round < max_rounds) {
      log(`\n--- interactive pause (round ${round}) ---\n`);
      const feedback = await human_intermission(snowball, round);

      if (feedback) {
        snowball = {
          ...snowball,
          human_directives: [...snowball.human_directives, feedback],
        };
        log(`human directive recorded (${feedback.length} chars)`);
      } else {
        log("no feedback, continuing...");
      }
    }

    if (plateaued) break;
  }

  // run summary to STDERR
  const elapsed_s = Math.round((Date.now() - start_time) / 1000);
  const elapsed_str = elapsed_s >= 60
    ? `${Math.floor(elapsed_s / 60)}m ${elapsed_s % 60}s`
    : `${elapsed_s}s`;
  const out_draft = snowball.best_draft ?? snowball.draft;
  const word_count = out_draft.split(/\s+/).length;
  const trail_count = snowball.critique_trail.length;
  const must_count = snowball.invariants.MUST.length;
  const should_count = snowball.invariants.SHOULD.length;
  const must_not_count = snowball.invariants.MUST_NOT.length;

  if (signal_received) {
    log_warn(`\n=== joust interrupted ===`);
    log(`steps: ${step} | elapsed: ${elapsed_str}`);
    log(`state saved. resume with: joust /run ${dir}/`);
  } else {
    log_header(`=== joust complete ===`);
    log(`steps: ${step} | invariants: ${must_count} MUST, ${should_count} SHOULD, ${must_not_count} MUST NOT`);
    if (snowball.best_scoring) {
      log(`best:  agg=${snowball.best_scoring.weighted_aggregate.toFixed(3)}${snowball.best_scoring.color_tier ? ` tier=${snowball.best_scoring.color_tier}` : ""}`);
    }
    log(`draft: ${word_count} words | critiques: ${trail_count} | elapsed: ${elapsed_str}`);

    // final output to STDOUT (teed to logs/stdout.txt)
    // prefer best_draft when strategy scoring tracked it; fall back to
    // current draft for legacy runs that never scored.
    write_stdout(out_draft);
  }
  } finally {
    if (timeout_id !== null) clearTimeout(timeout_id);
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    cleanup_tmp_files(dir);
    release_lock(dir);
  }
}

// --- exported for tests ---

export const _is_plateau = is_plateau;
export const _migrate_snowball = migrate_snowball;
