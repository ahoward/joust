import { resolve, join } from "path";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { call_agent_structured } from "./ai";
import { compile_context } from "./context";
import { resolve_config, get_main_agent, get_jousters } from "./config";
import { lint_mutation } from "./lint";
import { tank_execute, parse_duration, is_timeboxed_out } from "./tank";
import {
  read_latest_history,
  next_step_number,
  commit_state,
  log,
  log_status,
  to_json,
  append_log,
} from "./utils";
import {
  MutationResultSchema,
  type Snowball,
  type HistoryEntry,
  type CritiqueEntry,
} from "./types";

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
  const abort_controller = timeout_ms ? new AbortController() : null;

  if (timeout_ms && abort_controller) {
    setTimeout(() => abort_controller.abort("hard timeout reached"), timeout_ms);
  }

  // re-read config at round boundary
  let config = resolve_config(dir);
  let main = get_main_agent(config);
  let jousters = get_jousters(config);
  const max_retries = config.defaults.max_retries;
  const max_rounds = config.defaults.max_rounds;
  const interactive_interval = options.interactive ?? 0;

  for (let round = 1; round <= max_rounds; round++) {
    // check timebox at round boundary
    if (timebox_ms && is_timeboxed_out(start_time, timebox_ms)) {
      log(`\ntimebox reached after ${Math.round((Date.now() - start_time) / 1000)}s`);
      break;
    }

    // re-read config at round boundary (supports mid-flight edits)
    config = resolve_config(dir);
    main = get_main_agent(config);
    jousters = get_jousters(config);

    log(`\n=== round ${round}/${max_rounds} ===\n`);

    for (const jouster of jousters) {
      // check timebox before each agent
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

        const execute_jouster = async () => {
          // compile context for jouster
          const messages = compile_context(jouster, snowball, "jouster");

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
          const signal = abort_controller?.signal;
          const mutation = await call_agent_structured(jouster, messages, MutationResultSchema, { signal });

          // log the raw output
          await append_log(dir, `agent-${jouster.name}.log`, `\n--- step ${step} attempt ${attempts} ---\n${mutation.critique}\n`);

          // lint the mutation
          const lint = await lint_mutation(main, snowball, mutation.draft);

          return { mutation, lint };
        };

        try {
          let result;

          if (options.tank) {
            result = await tank_execute(jouster.name, execute_jouster);
            if (!result) {
              // tank mode: agent totally failed, skip
              log_status(jouster.name, "skipped (tank mode: agent unavailable)");
              await append_log(dir, "execution.log", `\n--- ${new Date().toISOString()} ---\n${jouster.name} SYSTEM_FAILURE: skipped by tank mode\n`);
              break;
            }
          } else {
            result = await execute_jouster();
          }

          const { mutation, lint } = result;

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

            await commit_state(dir, step, jouster.name, entry);
            step++;
            accepted = true;

            log_status(jouster.name, `accepted (attempt ${attempts})`);
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

            await commit_state(dir, step, jouster.name, entry);
            step++;

            log_status(jouster.name, `rejected (attempt ${attempts}/${max_retries})`);
          }
        } catch (err: any) {
          if (err.name === "AbortError") {
            log_status(jouster.name, "aborted by hard timeout");
            const entry: HistoryEntry = {
              step,
              actor: jouster.name,
              action: "mutation",
              status: "aborted",
              timestamp: new Date().toISOString(),
              snowball,
            };
            await commit_state(dir, step, jouster.name, entry);
            step++;
            break;
          }

          log_status(jouster.name, `error: ${err.message}`);
          await append_log(dir, "execution.log", `\n--- ${new Date().toISOString()} ---\n${jouster.name} error: ${err.message}\n`);
        }
      }

      if (!accepted) {
        log_status(jouster.name, `skipped after ${max_retries} failed attempts`);
        await append_log(dir, "execution.log", `\n--- ${new Date().toISOString()} ---\n${jouster.name} exhausted retries, skipping\n`);
      }
    }

    // main polish at end of round
    log_status("main", "polishing draft...");

    try {
      const polish_fn = async () => {
        const polish_messages = compile_context(main, snowball, "polish");
        return await call_agent_structured(main, polish_messages, MutationResultSchema, {
          signal: abort_controller?.signal,
        });
      };

      const polish = options.tank ? await tank_execute("main", polish_fn) : await polish_fn();

      if (polish) {
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

        await commit_state(dir, step, "main", entry);
        step++;

        log_status("main", "polish complete");
      }
    } catch (err: any) {
      log_status("main", `polish error: ${err.message}`);
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

  // final output to STDOUT
  process.stdout.write(snowball.draft);
}
