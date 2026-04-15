import { watch, existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve, basename } from "path";
import { log } from "./utils";

// --- colors ---

const COLORS: Record<string, string> = {
  main: "\x1b[36m",       // cyan
  security: "\x1b[31m",   // red
  cfo: "\x1b[33m",        // yellow
  dba: "\x1b[32m",        // green
  execution: "\x1b[90m",  // gray
};

const RESET = "\x1b[0m";

function color_for(name: string): string {
  // extract agent name from filename like "agent-security.log"
  const agent = name.replace("agent-", "").replace(".log", "");
  return COLORS[agent] ?? "\x1b[35m"; // default magenta
}

function prefix_for(name: string): string {
  const agent = name.replace("agent-", "").replace(".log", "");
  return agent.padEnd(12);
}

// --- tail ---

export async function tail(dir: string): Promise<void> {
  dir = resolve(dir);
  const logs_dir = join(dir, "logs");

  if (!existsSync(logs_dir)) {
    log(`no logs directory found at ${logs_dir}`);
    process.exit(1);
  }

  log(`tailing ${logs_dir}/\n`);

  // track file sizes to only show new content
  const sizes: Record<string, number> = {};

  // initial read of existing files
  const files = readdirSync(logs_dir).filter((f) => f.endsWith(".log"));
  for (const file of files) {
    const path = join(logs_dir, file);
    sizes[file] = statSync(path).size;
  }

  // watch for changes
  const watcher = watch(logs_dir, (event, filename) => {
    if (!filename || !filename.endsWith(".log")) return;

    const path = join(logs_dir, filename);
    if (!existsSync(path)) return;

    const stat = statSync(path);
    const prev_size = sizes[filename] ?? 0;

    if (stat.size > prev_size) {
      // read only the new bytes
      const fd = require("fs").openSync(path, "r");
      const buf = Buffer.alloc(stat.size - prev_size);
      require("fs").readSync(fd, buf, 0, buf.length, prev_size);
      require("fs").closeSync(fd);

      const new_text = buf.toString("utf-8");
      const color = color_for(filename);
      const prefix = prefix_for(filename);

      for (const line of new_text.split("\n")) {
        if (line.trim()) {
          process.stderr.write(`${color}[${prefix}]${RESET} ${line}\n`);
        }
      }

      sizes[filename] = stat.size;
    }
  });

  // keep alive
  log("watching for changes... (ctrl+c to stop)\n");
  await new Promise(() => {}); // block forever
}
