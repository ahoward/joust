#!/usr/bin/env bun

import { init } from "./init";
import { run, type RunOptions } from "./run";
import { tail } from "./tail";
import { log } from "./utils";

// --- arg parsing ---

function parse_args(argv: string[]): { command: string; rest: string[]; options: RunOptions } {
  const command = argv[0] ?? "--help";
  const rest: string[] = [];
  const options: RunOptions = {};

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--tank") {
      options.tank = true;
    } else if (arg.startsWith("--timebox")) {
      if (arg.includes("=")) {
        options.timebox = arg.split("=")[1];
      } else {
        options.timebox = argv[++i];
      }
    } else if (arg.startsWith("--timeout")) {
      if (arg.includes("=")) {
        options.timeout = arg.split("=")[1];
      } else {
        options.timeout = argv[++i];
      }
    } else if (arg.startsWith("--interactive")) {
      if (arg.includes("=")) {
        options.interactive = parseInt(arg.split("=")[1], 10);
      } else {
        options.interactive = 1;
      }
    } else if (arg === "-i") {
      options.interactive = 1;
    } else {
      rest.push(arg);
    }
  }

  return { command, rest, options };
}

async function main() {
  const { command, rest, options } = parse_args(process.argv.slice(2));

  switch (command) {
    case "init": {
      await init(rest);
      break;
    }

    case "draft": {
      // bootstrap + immediately run
      const dir = await init(rest, { run_after: true });
      await run(dir, options);
      break;
    }

    case "run": {
      const dir = rest[0] || ".";
      await run(dir, options);
      break;
    }

    case "tail": {
      const tail_dir = rest[0] || ".";
      await tail(tail_dir);
      break;
    }

    case "--help":
    case "-h": {
      print_help();
      break;
    }

    default: {
      log(`unknown command: ${command}`);
      log("run 'joust --help' for usage");
      process.exit(1);
    }
  }
}

function print_help() {
  log("joust — adversarial architecture compiler");
  log("");
  log("usage:");
  log("  joust init <prompt>     bootstrap state directory");
  log("  joust draft <prompt>    bootstrap + run immediately");
  log("  joust run [dir]         start or resume accumulator loop");
  log("  joust tail [dir]        stream agent logs in real-time");
  log("");
  log("flags:");
  log("  --interactive[=N]       pause every N rounds for human feedback");
  log("  --timebox <duration>    autonomy budget (e.g., 45m, 1h)");
  log("  --timeout <duration>    hard kill limit");
  log("  --tank                  unstoppable mode (backoff 429s, skip 5xx)");
  log("");
  log("examples:");
  log('  joust draft "design a caching layer for a mobile api"');
  log('  joust init "realtime bidding engine"');
  log("  joust run ./realtime-bidding-engine/ --tank --timebox 1h");
  log("  joust run ./my-project/ --interactive=3");
}

main().catch((err) => {
  log(`fatal: ${err.message}`);
  process.exit(1);
});
