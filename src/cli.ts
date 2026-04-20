#!/usr/bin/env bun

import { init } from "./init";
import { run, type RunOptions } from "./run";
import { tail } from "./tail";
import { status, export_draft, diff, plan, ask } from "./commands";
import { log } from "./utils";
import { JoustError, JoustUserError } from "./errors";
import { is_preset, PRESETS, normalize_gemini_env, type Preset } from "./config";

// mirror GEMINI_API_KEY → GOOGLE_GENERATIVE_AI_API_KEY so either works.
// Must run before any agent config resolution or API call.
normalize_gemini_env();

// --- known commands (slash-prefixed) ---

const COMMANDS = new Set([
  "init", "prompt", "run", "tail", "status", "export", "diff", "plan", "ask", "help",
]);

function parse_command(raw: string): { command: string; is_command: boolean } {
  if (raw === "--help" || raw === "-h") return { command: "help", is_command: true };
  if (raw.startsWith("/")) {
    const name = raw.slice(1);
    if (COMMANDS.has(name)) return { command: name, is_command: true };
    throw new JoustUserError(`unknown command: ${raw}\navailable: ${[...COMMANDS].map(c => "/" + c).join(", ")}`);
  }
  return { command: raw, is_command: false };
}

// --- arg parsing ---

function parse_args(argv: string[]): { command: string; is_command: boolean; rest: string[]; options: RunOptions; preset?: Preset } {
  const first = argv[0] ?? "--help";
  const { command, is_command } = parse_command(first);
  const rest: string[] = [];
  const options: RunOptions = {};
  let preset: Preset | undefined;

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
    } else if (arg.startsWith("--preset")) {
      const val = arg.includes("=") ? arg.split("=")[1] : argv[++i];
      if (!val || !is_preset(val)) {
        throw new JoustUserError(`invalid preset: ${val}. available: ${PRESETS.join(", ")}`);
      }
      preset = val;
    } else if (rest.length === 0 && is_preset(arg) && is_command && (command === "init" || command === "prompt")) {
      // positional preset: `joust /init gemini "my prompt"`
      preset = arg;
    } else {
      rest.push(arg);
    }
  }

  return { command, is_command, rest, options, preset };
}

async function main() {
  const { command, is_command, rest, options, preset } = parse_args(process.argv.slice(2));

  // bare string — treat entire argv as a prompt and draft it
  // e.g. `joust "design a caching layer"` => `joust /draft "design a caching layer"`
  if (!is_command) {
    const prompt_parts = [command, ...rest];
    const dir = await init(prompt_parts, preset);
    await run(dir, options);
    return;
  }

  switch (command) {
    case "init": {
      await init(rest, preset);
      break;
    }

    case "prompt": {
      const dir = await init(rest, preset);
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
        throw new JoustUserError("usage: joust /ask [dir] <agent> <question>");
      }
      await ask(ask_dir, agent_name, question);
      break;
    }

    case "help": {
      print_help();
      break;
    }
  }
}

function print_help() {
  log("joust — adversarial architecture compiler");
  log("");
  log("usage:");
  log("  joust <prompt>              bare string = bootstrap + run");
  log("  joust /prompt <prompt>      explicit prompt (escapes prompts starting with /)");
  log("  joust /init <prompt>        bootstrap state directory only");
  log("  joust /run [dir]            start or resume accumulator loop");
  log("  joust /tail [dir]           stream agent logs in real-time");
  log("  joust /status [dir]         show current run status");
  log("  joust /export [dir]         output latest draft to stdout");
  log("  joust /diff [dir] [a] [b]   diff between two history steps");
  log("  joust /plan [dir]           estimate token usage and cost");
  log("  joust /ask [dir] <agent> <question>");
  log("");
  log("flags:");
  log("  --preset <name>         agent preset (auto-detected from env by default)");
  log("  --interactive[=N]       pause every N rounds for human feedback");
  log("  --timebox <duration>    autonomy budget (e.g., 45m, 1h)");
  log("  --timeout <duration>    hard kill limit");
  log("  --tank                  unstoppable mode (backoff 429s, skip 5xx)");
  log("");
  log("presets (default panel: two peer lead architects, specialists summoned on demand):");
  log("  mixed                   opus main + gemini peer (default when both keys set)");
  log("  anthropic               opus main + sonnet peer");
  log("  gemini                  gemini-2.5-pro main + peer");
  log("  openai                  gpt-4o main + peer");
  log("");
  log("examples:");
  log('  joust "design a caching layer for a mobile api"');
  log('  joust /prompt "/usr/local/bin must support sandboxed execution"');
  log('  joust /init gemini "realtime bidding engine"');
  log('  joust /prompt --preset openai "auth middleware"');
  log("  joust /run .joust/realtime-bidding-engine/ --tank --timebox 1h");
  log("  joust /run .joust/my-project/ --interactive=3");
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
