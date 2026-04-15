import { existsSync, mkdirSync, readdirSync, renameSync } from "fs";
import { join, resolve } from "path";
import { parse as parse_yaml } from "yaml";
import type { HistoryEntry, Snowball } from "./types";

// --- atomic write ---

export async function write_atomic(target_path: string, data: string): Promise<void> {
  const tmp_path = `${target_path}.tmp`;
  await Bun.write(tmp_path, data);
  renameSync(tmp_path, target_path);
}

// --- pretty json ---

export function to_json(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

// --- slugify ---

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// --- ensure directory ---

export function ensure_dir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

// --- config loader with env var expansion ---

export function expand_env_vars(text: string): string {
  return text.replace(/\$([A-Z0-9_]+)/g, (_match, name) => {
    const val = process.env[name];
    if (val === undefined) {
      throw new Error(`missing environment variable: $${name}`);
    }
    return val;
  });
}

export function load_config(path: string): unknown {
  const text = require("fs").readFileSync(path, "utf-8");
  return parse_yaml(text);
}

// --- history scanning ---

const HISTORY_RE = /^(\d+)-(.+)\.json$/;

export interface HistoryFile {
  step: number;
  slug: string;
  filename: string;
  path: string;
}

export function scan_history(dir: string): HistoryFile[] {
  const history_dir = join(dir, "history");
  if (!existsSync(history_dir)) return [];

  const files = readdirSync(history_dir)
    .filter((f) => HISTORY_RE.test(f))
    .map((f) => {
      const m = f.match(HISTORY_RE)!;
      return {
        step: parseInt(m[1], 10),
        slug: m[2],
        filename: f,
        path: join(history_dir, f),
      };
    })
    .sort((a, b) => a.step - b.step);

  return files;
}

export function read_latest_history(dir: string): HistoryEntry | null {
  const files = scan_history(dir);

  // walk backwards to find latest valid entry
  for (let i = files.length - 1; i >= 0; i--) {
    try {
      const text = require("fs").readFileSync(files[i].path, "utf-8");
      return JSON.parse(text) as HistoryEntry;
    } catch {
      console.error(`[warn] ignoring corrupted history: ${files[i].filename}`);
    }
  }

  return null;
}

export function next_step_number(dir: string): number {
  const files = scan_history(dir);
  if (files.length === 0) return 0;
  return files[files.length - 1].step + 1;
}

// --- write history + snowball atomically ---

export async function commit_state(
  dir: string,
  step: number,
  slug: string,
  entry: HistoryEntry
): Promise<void> {
  const data = to_json(entry);
  const history_path = join(dir, "history", `${String(step).padStart(3, "0")}-${slug}.json`);
  const snowball_path = join(dir, "snowball.json");

  await write_atomic(history_path, data);
  await write_atomic(snowball_path, to_json(entry.snowball));
}

// --- logging ---

export async function append_log(dir: string, log_name: string, text: string): Promise<void> {
  const log_path = join(dir, "logs", log_name);
  await Bun.write(log_path, text, { mode: 0o644 });
}

// --- stderr helpers ---

export function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

export function log_status(agent: string, action: string): void {
  process.stderr.write(`[${agent}] ${action}\n`);
}
