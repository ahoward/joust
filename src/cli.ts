#!/usr/bin/env bun

import { init } from "./init";
import { run, type RunOptions } from "./run";
import { tail } from "./tail";
import { status, export_draft, diff, plan, ask } from "./commands";
import { log } from "./utils";
import { JoustError, JoustUserError } from "./errors";

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
      const dir = await init(rest);
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

    case "status": {
      status(rest[0] || ".");
      break;
    }

    case "export": {
      export_draft(rest[0] || ".");
      break;
    }

    case "diff": {
      diff(rest[0] || ".", rest[1], rest[2]);
      break;
    }

    case "plan": {
      plan(rest[0] || ".");
      break;
    }

    case "ask": {
      const ask_dir = rest[0] || ".";
      const agent_name = rest[1];
      const question = rest.slice(2).join(" ");
      if (!agent_name || !question) {
        throw new JoustUserError("usage: joust ask [dir] <agent> <question>");
      }
      await ask(ask_dir, agent_name, question);
      break;
    }

    case "--help":
    case "-h": {
      print_help();
      break;
    }

    default: {
      throw new JoustUserError(`unknown command: ${command}\nrun 'joust --help' for usage`);
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
  log("  joust status [dir]      show current run status");
  log("  joust export [dir]      output latest draft to stdout");
  log("  joust diff [dir] [a] [b]  diff between two history steps");
  log("  joust plan [dir]          estimate token usage and cost");
  log("  joust ask [dir] <agent> <question>  one-shot query to an agent");
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

process.on("unhandledRejection", (err) => {
  log(`fatal: unhandled rejection: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(70); // EX_SOFTWARE
});

main().catch((err) => {
  // order is load-bearing: JoustUserError extends JoustError,
  // so the subclass check MUST come first (instanceof walks prototype chain)
  if (err instanceof JoustUserError) {
    log(err.message);
    process.exit(err.exit_code);
  }
  if (err instanceof JoustError) {
    log(`fatal: ${err.message}`);
    process.exit(err.exit_code);
  }
  // unknown errors: full detail for bug reports
  log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
