import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "fs";
import { join, resolve } from "path";
import { parse as parse_yaml } from "yaml";
import { HistoryEntrySchema } from "./types";
import type { HistoryEntry, Snowball } from "./types";

// --- atomic write ---

export function write_atomic(target_path: string, data: string): void {
  const tmp_path = `${target_path}.tmp`;
  const fd = openSync(tmp_path, "w", 0o644);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
  } catch (e) {
    try { closeSync(fd); } catch {}
    try { unlinkSync(tmp_path); } catch {}
    throw e;
  }
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
  const text = readFileSync(path, "utf-8");
  return parse_yaml(text); // no env expansion here — happens only on api_key fields in config.ts
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
      const text = readFileSync(files[i].path, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        log(`[warn] ${files[i].filename} contains invalid JSON — skipping`);
        continue;
      }
      const result = HistoryEntrySchema.safeParse(parsed);
      if (!result.success) {
        log(`[warn] ${files[i].filename} failed validation: ${result.error.message} — skipping`);
        continue;
      }
      return result.data as HistoryEntry;
    } catch {
      log(`[warn] ignoring corrupted history: ${files[i].filename}`);
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

export function commit_state(
  dir: string,
  step: number,
  slug: string,
  entry: HistoryEntry
): void {
  const data = to_json(entry);
  const history_path = join(dir, "history", `${String(step).padStart(3, "0")}-${slug}.json`);
  const snowball_path = join(dir, "snowball.json");

  // write snowball first: if crash occurs after snowball but before history,
  // the next startup derives the correct snowball from history (harmlessly ahead)
  write_atomic(snowball_path, to_json(entry.snowball));
  write_atomic(history_path, data);
}

// --- logging ---

export function append_log(dir: string, log_name: string, text: string): void {
  const log_path = join(dir, "logs", log_name);
  appendFileSync(log_path, scrub_keys(text));
}

// --- lockfile ---

export function acquire_lock(dir: string): void {
  const lock_path = join(dir, ".joust.lock");
  let fd: number;
  try {
    fd = openSync(lock_path, "wx"); // O_WRONLY | O_CREAT | O_EXCL — atomic
  } catch (e: any) {
    if (e.code === "EEXIST") {
      const pid = parseInt(readFileSync(lock_path, "utf-8").trim(), 10);
      if (is_process_alive(pid)) {
        throw new Error(`joust is already running in this directory (PID ${pid})`);
      }
      // stale lock — remove and retry
      unlinkSync(lock_path);
      try {
        fd = openSync(lock_path, "wx");
      } catch (e2: any) {
        throw new Error(`concurrent joust startup detected — another process claimed the lock`);
      }
    } else {
      throw e;
    }
  }
  writeSync(fd, String(process.pid));
  closeSync(fd);
}

export function release_lock(dir: string): void {
  const lock_path = join(dir, ".joust.lock");
  try { unlinkSync(lock_path); } catch {}
}

function is_process_alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// --- key scrubbing (defense-in-depth) ---
// order matters: sk-ant- must match before sk- to avoid partial matches

const KEY_PATTERNS = [
  /sk-ant-[a-zA-Z0-9\-_]{20,}/g,
  /sk-[a-zA-Z0-9\-_]{20,}/g,
  /AIza[a-zA-Z0-9\-_]{20,}/g,
];

export function scrub_keys(text: string): string {
  return KEY_PATTERNS.reduce((t, pat) => t.replace(pat, "[REDACTED]"), text);
}

// --- object-level redaction (complements scrub_keys for config serialization) ---

const SENSITIVE_KEYS = new Set([
  "api_key", "apiKey", "apikey",
  "token", "secret", "password",
  "authorization", "Authorization",
]);

export function redact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k,
      SENSITIVE_KEYS.has(k) ? "[REDACTED]" : v,
    ])
  );
}

// --- stderr helpers ---

export function log(msg: string): void {
  process.stderr.write(`${scrub_keys(msg)}\n`);
}

export function log_status(agent: string, action: string): void {
  process.stderr.write(`[${agent}] ${scrub_keys(action)}\n`);
}
