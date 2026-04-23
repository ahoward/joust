import { resolve, join } from "path";
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { call_agent_structured } from "./ai";
import { compile_context } from "./context";
import { resolve_config, get_main_agent, get_jousters } from "./config";
import { score_draft, compare_results } from "./lint";
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
  append_log,
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

// --- options ---

export interface RunOptions {
  tank?: boolean;
  timebox?: string;
  timeout?: string;
  interactive?: number;
}

// --- plateau detection ---
//
// the loop stops if aggregate has not improved by > PLATEAU_EPSILON
// for PLATEAU_K consecutive rounds. these are phase-1 constants;
// phase 2 will move them to config.

const PLATEAU_EPSILON = 0.02;
const PLATEAU_K = 2;

function is_plateau(history: number[]): boolean {
  if (history.length < PLATEAU_K + 1) return false;
  const recent = history.slice(-PLATEAU_K - 1);
  const peak = recent[0]!;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i]! - peak > PLATEAU_EPSILON) return false;
  }
  return true;
}

// --- draft-fitness helper ---
//
// scores `candidate` against the configured strategies. returns a
// ScoringResult the caller can feed to compare_results and the
// best-so-far tracker.

async function score_candidate(
  main: AgentConfig,
  strategies: StrategiesConfig,
  snowball: Snowball,
  candidate_draft: string,
  options?: { signal?: AbortSignal; tank?: boolean }
): Promise<ScoringResult | null> {
  const run = async () =>
    score_draft(main, strategies, snowball, candidate_draft, {
      signal: options?.signal,
    });
  if (options?.tank) {
    return await tank_execute("main", run);
  }
  try {
    return await run();
  } catch (err: any) {
    log_status("main", `scoring error: ${err.message}`);
    return null;
  }
}

// --- interactive intermission ---

async function human_intermission(snowball: Snowball, round: number): Promise<string | null> {
  const editor = process.env.EDITOR || "vi";
  const tmp_file = join(tmpdir(), `joust-feedback-${Date.now()}.md`);

  const word_count = snowball.draft.split(/\s+/).length;
  const trail_count = snowball.critique_trail.length;

  const buffer = [
    `# joust intermission — round ${round}`,
    `# ${word_count} words | ${trail_count} critiques`,
    `#`,
    `# recent activity:`,
    ...snowball.critique_trail.slice(-3).map((c) => `#   [${c.actor}] ${c.notes.slice(0, 100)}`),
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
  try { unlinkSync(tmp_file); } catch {}
  const lines = content
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n")
    .trim();

  return lines || null;
}

// --- migration on load ---
//
// legacy entries lack `strategies`/`best_*`. if missing, derive the
// strategies config from the legacy `invariants` field — this preserves
// the existing invariants-only behavior for old runs without requiring
// them to re-bootstrap. the best_draft starts as the current draft.

function migrate_snowball(snow: Snowball): Snowball {
  if (snow.strategies) return snow; // already migrated

  const inv = snow.invariants;
  const has_rules = inv.MUST.length + inv.SHOULD.length + inv.MUST_NOT.length > 0;
  const strategies: StrategiesConfig = has_rules
    ? { invariants: { MUST: inv.MUST, SHOULD: inv.SHOULD, MUST_NOT: inv.MUST_NOT } }
    : {};

  return {
    ...snow,
    strategies,
    best_draft: snow.draft,
    best_scoring: undefined, // will be populated on first scoring
    aggregate_history: [],
  };
}

// --- the accumulator loop ---

export async function run(dir: string, options: RunOptions = {}): Promise<void> {
  dir = resolve(dir);
  acquire_lock(dir);

  const latest = read_latest_history(dir);
  if (!latest) {
    throw new Error(`no history found in ${dir}/history/ — run 'joust init' first`);
  }

  let snowball: Snowball = migrate_snowball(latest.snowball);
  let step = next_step_number(dir);

  const strategies = snowball.strategies ?? {};
  const strategy_names = Object.keys(strategies);

  log(`\nresuming from step ${latest.step} (${latest.actor}/${latest.action})`);
  log(`draft: ${snowball.draft.length} chars`);
  if (strategy_names.length > 0) {
    log(`strategies: ${strategy_names.join(", ")}`);
  } else {
    log(`strategies: (none configured — every mutation accepts trivially)`);
  }
  log("");

  const start_time = Date.now();
  const timebox_ms = options.timebox ? parse_duration(options.timebox) : null;
  const timeout_ms = options.timeout ? parse_duration(options.timeout) : null;
  const abort_controller = new AbortController();

  const timeout_id = timeout_ms
    ? setTimeout(() => abort_controller.abort("hard timeout reached"), timeout_ms)
    : null;

  let signal_received = false;
  const on_signal = (sig: string) => {
    if (signal_received) {
      log(`\n${sig} received again, forcing exit`);
      process.exit(128 + (sig === "SIGINT" ? 2 : 15));
    }
    signal_received = true;
    log(`\n${sig} received, shutting down gracefully...`);
    abort_controller.abort(`${sig} received`);
  };
  const on_sigint = () => on_signal("SIGINT");
  const on_sigterm = () => on_signal("SIGTERM");
  process.on("SIGINT", on_sigint);
  process.on("SIGTERM", on_sigterm);

  let config = resolve_config(dir);
  let main = get_main_agent(config);
  let jousters = get_jousters(config);
  const max_retries = config.defaults.max_retries;
  const max_rounds = config.defaults.max_rounds;
  const interactive_interval = options.interactive ?? 0;

  // seed the best-so-far tracker if this is the first real round
  if (!snowball.best_scoring && snowball.best_draft !== undefined) {
    const seed = await score_candidate(main, strategies, snowball, snowball.best_draft, {
      signal: abort_controller.signal,
      tank: options.tank,
    });
    if (seed) {
      snowball = { ...snowball, best_scoring: seed };
      log(`seed score: aggregate=${seed.weighted_aggregate.toFixed(3)}${seed.color_tier ? ` tier=${seed.color_tier}` : ""}${seed.passed ? "" : " [floor violations]"}`);
    }
  }

  try {
  let plateaued = false;

  for (let round = 1; round <= max_rounds && !plateaued; round++) {
    if (signal_received) {
      log(`\nexiting after signal`);
      break;
    }
    if (timebox_ms && is_timeboxed_out(start_time, timebox_ms)) {
      log(`\ntimebox reached after ${Math.round((Date.now() - start_time) / 1000)}s`);
      break;
    }

    config = resolve_config(dir);
    main = get_main_agent(config);
    jousters = get_jousters(config);

    log(`\n=== round ${round}/${max_rounds} ===\n`);

    for (const jouster of jousters) {
      if (timebox_ms && is_timeboxed_out(start_time, timebox_ms)) {
        log(`\ntimebox reached, pausing before ${jouster.name}`);
        break;
      }

      log_status(jouster.name, "mutating draft...");

      let accepted = false;
      let attempts = 0;
      let last_violations: string[] = [];

      while (!accepted && attempts < max_retries) {
        attempts++;

        const execute_mutation = async () => {
          const messages = compile_context(jouster, snowball, "jouster");
          if (last_violations.length > 0) {
            messages.push({
              role: "user",
              content: [
                "YOUR PREVIOUS ATTEMPT WAS REJECTED for the following:",
                ...last_violations.map((v) => `  - ${v}`),
                "",
                "Rewrite your mutation to fix these.",
              ].join("\n"),
            });
          }
          return await call_agent_structured(jouster, messages, MutationResultSchema, {
            signal: abort_controller.signal,
          });
        };

        try {
          let mutation;
          if (options.tank) {
            mutation = await tank_execute(jouster.name, execute_mutation);
            if (!mutation) {
              log_status(jouster.name, "skipped (tank mode: agent unavailable)");
              append_log(dir, "execution.log",
                `\n--- ${new Date().toISOString()} ---\n${jouster.name} SYSTEM_FAILURE: skipped by tank mode\n`);
              break;
            }
          } else {
            mutation = await execute_mutation();
          }

          append_log(dir, `agent-${jouster.name}.log`,
            `\n--- step ${step} attempt ${attempts} ---\n${mutation.critique}\n`);

          const scoring = await score_candidate(main, strategies, snowball, mutation.draft, {
            signal: abort_controller.signal,
            tank: options.tank,
          });

          // if scoring failed outright, treat like legacy: accept mutation
          // (trust the jouster), log and move on. the next jouster/polish
          // will have a chance to re-score.
          if (!scoring) {
            log_status("main", "scoring unavailable, accepting mutation");
            accepted = true;
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
            };
            commit_state(dir, step, jouster.name, {
              step,
              actor: jouster.name,
              action: "mutation",
              status: "accepted",
              timestamp: new Date().toISOString(),
              snowball,
            });
            step++;
            break;
          }

          const best = snowball.best_scoring;
          const is_better_or_equal = best ? compare_results(scoring, best) >= 0 : true;

          if (scoring.passed && is_better_or_equal) {
            accepted = true;
            const critique_entry: CritiqueEntry = {
              actor: jouster.name,
              action: "mutated_draft",
              notes: mutation.critique,
              timestamp: new Date().toISOString(),
            };
            snowball = {
              ...snowball,
              draft: mutation.draft,
              best_draft: mutation.draft,
              best_scoring: scoring,
              critique_trail: [...snowball.critique_trail, critique_entry],
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
            log_status(
              jouster.name,
              `accepted (attempt ${attempts}, agg=${scoring.weighted_aggregate.toFixed(3)}${scoring.color_tier ? ` tier=${scoring.color_tier}` : ""})`
            );
          } else {
            // rejected — floor violation or didn't improve
            const reasons: string[] = [];
            if (!scoring.passed) {
              for (const v of scoring.floor_violations) {
                reasons.push(`${v.strategy}/${v.dimension}: ${v.rationale}`);
              }
            } else if (best) {
              reasons.push(
                `no improvement over best (agg=${scoring.weighted_aggregate.toFixed(3)} vs best=${best.weighted_aggregate.toFixed(3)}${scoring.color_tier ? ` tier=${scoring.color_tier}` : ""})`
              );
            }
            last_violations = reasons;

            const entry: HistoryEntry = {
              step,
              actor: jouster.name,
              action: "mutation",
              status: "rejected",
              timestamp: new Date().toISOString(),
              snowball: { ...snowball, draft: mutation.draft },
              violations: reasons,
            };
            commit_state(dir, step, jouster.name, entry);
            step++;
            log_status(jouster.name, `rejected (attempt ${attempts}/${max_retries})`);
          }
        } catch (err: any) {
          if (err.name === "AbortError") {
            log_status(jouster.name, "aborted by hard timeout");
            commit_state(dir, step, jouster.name, {
              step,
              actor: jouster.name,
              action: "mutation",
              status: "aborted",
              timestamp: new Date().toISOString(),
              snowball,
            });
            step++;
            break;
          }
          log_status(jouster.name, `error: ${err.message}`);
          append_log(dir, "execution.log",
            `\n--- ${new Date().toISOString()} ---\n${jouster.name} error: ${err.message}\n`);
        }
      }

      if (!accepted) {
        log_status(jouster.name, `skipped after ${max_retries} failed attempts`);
        append_log(dir, "execution.log",
          `\n--- ${new Date().toISOString()} ---\n${jouster.name} exhausted retries, skipping\n`);

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
          const marker_path = join(dir, ".needs-attention");
          const marker = `${jouster.name} exhausted ${max_retries} retries at step ${step}, round ${round}.\n` +
            `Last violations: ${last_violations.join("; ")}\n` +
            `Timestamp: ${new Date().toISOString()}\n`;
          try { writeFileSync(marker_path, marker); } catch {}
          log(`[warn] wrote ${marker_path} — ${jouster.name} needs attention`);
        }
      }
    }

    // compaction
    try {
      const compaction_threshold = config.defaults.compaction_threshold;
      const compact_fn = async () =>
        maybe_compact(main, snowball, compaction_threshold, { signal: abort_controller.signal });
      const compacted = options.tank
        ? await tank_execute("main", compact_fn)
        : await compact_fn();
      if (compacted && compacted !== snowball) {
        snowball = compacted;
        commit_state(dir, step, "main", {
          step,
          actor: "main",
          action: "compact",
          status: "accepted",
          timestamp: new Date().toISOString(),
          snowball,
        });
        step++;
      }
    } catch (err: any) {
      log_status("main", `compaction error: ${err.message}`);
    }

    // polish: same compare gate as jousters. polish that regresses is dropped.
    log_status("main", "polishing draft...");
    try {
      const polish_fn = async () => {
        const polish_messages = compile_context(main, snowball, "polish");
        return await call_agent_structured(main, polish_messages, MutationResultSchema, {
          signal: abort_controller.signal,
        });
      };
      const polish = options.tank ? await tank_execute("main", polish_fn) : await polish_fn();

      if (polish) {
        const polish_scoring = await score_candidate(main, strategies, snowball, polish.draft, {
          signal: abort_controller.signal,
          tank: options.tank,
        });

        const best = snowball.best_scoring;
        const polish_better =
          polish_scoring && polish_scoring.passed &&
          (best ? compare_results(polish_scoring, best) >= 0 : true);

        if (polish_better && polish_scoring) {
          const critique_entry: CritiqueEntry = {
            actor: "main",
            action: "polish",
            notes: polish.critique,
            timestamp: new Date().toISOString(),
          };
          snowball = {
            ...snowball,
            draft: polish.draft,
            best_draft: polish.draft,
            best_scoring: polish_scoring,
            critique_trail: [...snowball.critique_trail, critique_entry],
          };
          commit_state(dir, step, "main", {
            step,
            actor: "main",
            action: "polish",
            status: "accepted",
            timestamp: new Date().toISOString(),
            snowball,
          });
          step++;
          log_status("main", `polish accepted (agg=${polish_scoring.weighted_aggregate.toFixed(3)})`);
        } else if (polish_scoring) {
          log_status(
            "main",
            `polish rejected (${!polish_scoring.passed ? "floor violation" : "no improvement"})`
          );
          commit_state(dir, step, "main", {
            step,
            actor: "main",
            action: "polish",
            status: "rejected",
            timestamp: new Date().toISOString(),
            snowball: { ...snowball, draft: polish.draft },
            violations: polish_scoring.floor_violations.map((v) => `${v.strategy}/${v.dimension}: ${v.rationale}`),
          });
          step++;
        } else {
          // scoring unavailable — accept as legacy behavior
          log_status("main", "polish accepted (scoring unavailable)");
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
          };
          commit_state(dir, step, "main", {
            step,
            actor: "main",
            action: "polish",
            status: "accepted",
            timestamp: new Date().toISOString(),
            snowball,
          });
          step++;
        }
      }
    } catch (err: any) {
      log_status("main", `polish error: ${err.message}`);
    }

    // record this round's aggregate for plateau detection
    if (snowball.best_scoring) {
      const hist = [...(snowball.aggregate_history ?? []), snowball.best_scoring.weighted_aggregate];
      snowball = { ...snowball, aggregate_history: hist };
      if (is_plateau(hist)) {
        plateaued = true;
        log(`\nplateau detected (${PLATEAU_K} rounds without improvement of > ${PLATEAU_EPSILON})`);
      }
    }

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
  }

  const elapsed_s = Math.round((Date.now() - start_time) / 1000);
  const elapsed_str = elapsed_s >= 60
    ? `${Math.floor(elapsed_s / 60)}m ${elapsed_s % 60}s`
    : `${elapsed_s}s`;
  const out_draft = snowball.best_draft ?? snowball.draft;
  const word_count = out_draft.split(/\s+/).length;
  const trail_count = snowball.critique_trail.length;

  log(`\n=== joust complete ===`);
  log(`steps: ${step} | strategies: ${strategy_names.length ? strategy_names.join(", ") : "(none)"}`);
  if (snowball.best_scoring) {
    log(`best:  aggregate=${snowball.best_scoring.weighted_aggregate.toFixed(3)}${snowball.best_scoring.color_tier ? ` tier=${snowball.best_scoring.color_tier}` : ""}`);
  }
  log(`draft: ${word_count} words | critiques: ${trail_count} | elapsed: ${elapsed_str}`);

  process.stdout.write(out_draft);
  } finally {
    if (timeout_id !== null) clearTimeout(timeout_id);
    process.removeListener("SIGINT", on_sigint);
    process.removeListener("SIGTERM", on_sigterm);
    cleanup_tmp_files(dir);
    release_lock(dir);
  }
}

// --- exported for tests ---

export const _is_plateau = is_plateau;
export const _migrate_snowball = migrate_snowball;
