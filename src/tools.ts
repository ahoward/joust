import { tool } from "ai";
import { z } from "zod";
import { realpathSync, readFileSync, readdirSync, statSync } from "fs";
import { resolve, relative, join } from "path";
import type { ToolSet } from "ai";

// --- path sandboxing ---

const MAX_FILE_SIZE = 64 * 1024; // 64KB
const MAX_LIST_RESULTS = 200;
const MAX_SEARCH_RESULTS = 100;

const IGNORE_PATTERNS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "bun.lock",
  "bun.lockb",
]);

function is_ignored(name: string): boolean {
  return IGNORE_PATTERNS.has(name) || name.endsWith(".min.js") || name.endsWith(".min.css");
}

export function safe_resolve(workspace: string, requested_path: string): string {
  // resolve the requested path against the workspace
  const resolved = resolve(workspace, requested_path);

  // use realpath to follow symlinks before checking containment
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    // file doesn't exist yet — check the resolved path directly
    real = resolved;
  }

  let real_workspace: string;
  try {
    real_workspace = realpathSync(workspace);
  } catch {
    real_workspace = workspace;
  }

  if (real !== real_workspace && !real.startsWith(real_workspace + "/")) {
    throw new Error(`path traversal blocked: ${requested_path}`);
  }

  return real;
}

// --- file reading ---

function read_file_impl(workspace: string, path: string): string {
  const full_path = safe_resolve(workspace, path);

  let stat;
  try {
    stat = statSync(full_path);
  } catch {
    return `error: file not found: ${path}`;
  }

  if (!stat.isFile()) {
    return `error: not a file: ${path}`;
  }

  if (stat.size > MAX_FILE_SIZE) {
    const content = readFileSync(full_path, "utf-8").slice(0, MAX_FILE_SIZE);
    return `${content}\n\n--- truncated at ${MAX_FILE_SIZE} bytes (file is ${stat.size} bytes) ---`;
  }

  try {
    return readFileSync(full_path, "utf-8");
  } catch {
    return `error: could not read file (binary?): ${path}`;
  }
}

// --- file listing ---

function walk_dir(dir: string, base: string, results: string[], pattern: RegExp): void {
  if (results.length >= MAX_LIST_RESULTS) return;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= MAX_LIST_RESULTS) return;
    if (is_ignored(entry.name)) continue;

    const full = join(dir, entry.name);
    const rel = relative(base, full);

    if (entry.isDirectory()) {
      walk_dir(full, base, results, pattern);
    } else if (entry.isFile() && pattern.test(rel)) {
      results.push(rel);
    }
  }
}

function glob_to_regex(pattern: string): RegExp {
  // simple glob → regex: * → [^/]*, ** → .*, ? → ., rest escaped
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern.charAt(i);
    if (c === "*" && pattern.charAt(i + 1) === "*") {
      re += ".*";
      i += 2;
      if (pattern.charAt(i) === "/") i++; // skip trailing slash after **
    } else if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += ".";
      i++;
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp("^" + re + "$");
}

function list_files_impl(workspace: string, pattern: string): string {
  const regex = glob_to_regex(pattern);
  const results: string[] = [];
  walk_dir(workspace, workspace, results, regex);

  if (results.length === 0) {
    return `no files matched pattern: ${pattern}`;
  }

  let output = results.join("\n");
  if (results.length >= MAX_LIST_RESULTS) {
    output += `\n\n--- capped at ${MAX_LIST_RESULTS} results. use a more specific pattern ---`;
  }
  return output;
}

// --- file searching ---

function search_files_impl(workspace: string, pattern: string, glob?: string): string {
  let file_regex: RegExp | null = null;
  if (glob) {
    file_regex = glob_to_regex(glob);
  }

  let search_regex: RegExp;
  try {
    search_regex = new RegExp(pattern, "i");
  } catch {
    return `error: invalid regex pattern: ${pattern}`;
  }

  const matches: string[] = [];

  function search_dir(dir: string): void {
    if (matches.length >= MAX_SEARCH_RESULTS) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= MAX_SEARCH_RESULTS) return;
      if (is_ignored(entry.name)) continue;

      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        search_dir(full);
      } else if (entry.isFile()) {
        const rel = relative(workspace, full);
        if (file_regex && !file_regex.test(rel)) continue;

        let content;
        try {
          const stat = statSync(full);
          if (stat.size > MAX_FILE_SIZE) continue; // skip huge files
          content = readFileSync(full, "utf-8");
        } catch {
          continue;
        }

        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= MAX_SEARCH_RESULTS) break;
          const line = lines[i] ?? "";
          if (search_regex.test(line)) {
            matches.push(`${rel}:${i + 1}: ${line}`);
          }
        }
      }
    }
  }

  search_dir(workspace);

  if (matches.length === 0) {
    return `no matches for pattern: ${pattern}${glob ? ` in files matching ${glob}` : ""}`;
  }

  let output = matches.join("\n");
  if (matches.length >= MAX_SEARCH_RESULTS) {
    output += `\n\n--- capped at ${MAX_SEARCH_RESULTS} matches. use a more specific pattern ---`;
  }
  return output;
}

// --- tool factory ---

export function create_workspace_tools(workspace: string): ToolSet {
  return {
    read_file: tool({
      description: "Read a file's contents. Path is relative to the project root.",
      inputSchema: z.object({
        path: z.string().describe("relative file path, e.g. 'src/main.ts'"),
      }),
      execute: async ({ path }: { path: string }) => read_file_impl(workspace, path),
    }),

    list_files: tool({
      description: "List files matching a glob pattern. Returns relative paths.",
      inputSchema: z.object({
        pattern: z.string().describe("glob pattern, e.g. '**/*.ts' or 'src/**/*.py'"),
      }),
      execute: async ({ pattern }: { pattern: string }) => list_files_impl(workspace, pattern),
    }),

    search_files: tool({
      description: "Search file contents for a regex pattern. Returns matching lines with file paths and line numbers.",
      inputSchema: z.object({
        pattern: z.string().describe("regex pattern to search for"),
        glob: z.string().optional().describe("optional glob to filter files, e.g. '**/*.ts'"),
      }),
      execute: async ({ pattern, glob }: { pattern: string; glob?: string }) =>
        search_files_impl(workspace, pattern, glob),
    }),
  };
}
