#!/usr/bin/env bun

import { init } from "./init";
import { run } from "./run";
import { log } from "./utils";

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);

async function main() {
  switch (command) {
    case "init": {
      await init(rest);
      break;
    }

    case "draft": {
      // bootstrap + immediately run
      const dir = await init(rest, { run_after: true });
      await run(dir);
      break;
    }

    case "run": {
      const dir = rest[0] || ".";
      await run(dir);
      break;
    }

    case "tail": {
      log("joust tail: not yet implemented");
      process.exit(1);
    }

    case "--help":
    case "-h":
    case undefined: {
      log("joust — adversarial architecture compiler");
      log("");
      log("usage:");
      log("  joust init <prompt>     bootstrap state directory");
      log("  joust draft <prompt>    bootstrap + run immediately");
      log("  joust run [dir]         start or resume accumulator loop");
      log("  joust tail [dir]        stream agent logs (not yet implemented)");
      log("");
      log("flags:");
      log("  --interactive[=N]       pause every N rounds for feedback");
      log("  --timebox <duration>    autonomy budget (e.g., 45m, 1h)");
      log("  --timeout <duration>    hard kill limit");
      log("  --tank                  unstoppable mode");
      log("");
      log("examples:");
      log('  joust draft "design a caching layer for a mobile api"');
      log('  joust init "realtime bidding engine" && $EDITOR ./realtime-bidding-engine/rfc.yaml && joust run ./realtime-bidding-engine/');
      log("  joust run --timebox 1h --tank ./my-project/");
      break;
    }

    default: {
      log(`unknown command: ${command}`);
      log("run 'joust --help' for usage");
      process.exit(1);
    }
  }
}

main().catch((err) => {
  log(`fatal: ${err.message}`);
  process.exit(1);
});
