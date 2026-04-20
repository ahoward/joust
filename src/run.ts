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
  preset_peer_pick,
  detect_preset,
} from "./config";
import { create_workspace_tools } from "./tools";
import { lint_mutation } from "./lint";
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

  let snowball = latest.snowball;
  let step = next_step_number(dir);

  log(`\nresuming from step ${latest.step} (${latest.actor}/${latest.action})`);
  log(`draft: ${snowball.draft.length} chars`);
  log(`invariants: ${snowball.invariants.MUST.length} MUST, ${snowball.invariants.SHOULD.length} SHOULD, ${snowball.invariants.MUST_NOT.length} MUST NOT`);
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
  let jousters = get_jousters(config);
  const max_retries = config.defaults.max_retries;
  const max_rounds = config.defaults.max_rounds;
  const interactive_interval = options.interactive ?? 0;
  let workspace_tools: ToolSet | undefined;
  let max_tool_steps: number | undefined;
  if (config.defaults.workspace) {
    workspace_tools = create_workspace_tools(config.defaults.workspace);
    max_tool_steps = config.defaults.max_tool_steps;
    log(`workspace: ${config.defaults.workspace} (agents have file access)`);
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

          append_log(dir, `agent-${jouster.name}.log`, `\n--- step ${step} attempt ${attempts} ---\n${mutation.critique}\n`);

          const execute_lint = async () => lint_mutation(main, snowball, mutation!.draft, {
            tools: workspace_tools,
            max_tool_steps,
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

            log_success(`[${jouster.name}] accepted (attempt ${attempts})`);

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
                  }
                );

                append_log(
                  dir,
                  `agent-${specialist_name}.log`,
                  `\n--- step ${step} summoned by ${jouster.name} ---\nask: ${ask}\n\n${spec_mutation.critique}\n`
                );

                const spec_lint = await lint_mutation(main, snowball, spec_mutation.draft, {
                  tools: workspace_tools,
                  max_tool_steps,
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
        });
      };

      const polish = options.tank ? await tank_execute("main", polish_fn) : await polish_fn();

      if (polish) {
        // lint the polish pass — warn but don't reject (main is trusted)
        try {
          const polish_lint = await lint_mutation(main, snowball, polish.draft, {
            tools: workspace_tools,
            max_tool_steps,
          });
          if (!polish_lint.valid) {
            log_warn(`[main] polish violated invariants: ${polish_lint.violations.join("; ")}`);
          }
        } catch {
          // lint failure during polish is non-fatal
        }

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

        log_status("main", "polish complete");
      }
    } catch (err: any) {
      if (!signal_received) log_error(`[main] polish error: ${err.message}`);
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
  }

  // run summary to STDERR
  const elapsed_s = Math.round((Date.now() - start_time) / 1000);
  const elapsed_str = elapsed_s >= 60
    ? `${Math.floor(elapsed_s / 60)}m ${elapsed_s % 60}s`
    : `${elapsed_s}s`;
  const word_count = snowball.draft.split(/\s+/).length;
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
    log(`draft: ${word_count} words | critiques: ${trail_count} | elapsed: ${elapsed_str}`);

    // final output to STDOUT (teed to logs/stdout.txt)
    write_stdout(snowball.draft);
  }
  } finally {
    if (timeout_id !== null) clearTimeout(timeout_id);
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    cleanup_tmp_files(dir);
    release_lock(dir);
  }
}
