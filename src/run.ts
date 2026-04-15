import { resolve } from "path";
import { call_agent_structured } from "./ai";
import { compile_context } from "./context";
import { resolve_config, get_main_agent, get_jousters } from "./config";
import { lint_mutation } from "./lint";
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

export async function run(dir: string): Promise<void> {
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

  // re-read config at round boundary
  const config = resolve_config(dir);
  const main = get_main_agent(config);
  const jousters = get_jousters(config);
  const max_retries = config.defaults.max_retries;
  const max_rounds = config.defaults.max_rounds;

  for (let round = 1; round <= max_rounds; round++) {
    log(`\n=== round ${round}/${max_rounds} ===\n`);

    for (const jouster of jousters) {
      log_status(jouster.name, "mutating draft...");

      let accepted = false;
      let attempts = 0;
      let last_violations: string[] = [];

      while (!accepted && attempts < max_retries) {
        attempts++;

        try {
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
          const mutation = await call_agent_structured(jouster, messages, MutationResultSchema);

          // log the raw output
          await append_log(dir, `agent-${jouster.name}.log`, `\n--- step ${step} attempt ${attempts} ---\n${mutation.critique}\n`);

          // lint the mutation
          const lint = await lint_mutation(main, snowball, mutation.draft);

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
          log_status(jouster.name, `error: ${err.message}`);
          attempts++;

          // log the error
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
      const polish_messages = compile_context(main, snowball, "polish");
      const polish = await call_agent_structured(main, polish_messages, MutationResultSchema);

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
    } catch (err: any) {
      log_status("main", `polish error: ${err.message}`);
    }

    // re-read config at round boundary (supports mid-flight edits)
    // (we already have it for this spike — just noting the boundary)
  }

  // final output to STDOUT
  process.stdout.write(snowball.draft);
}
