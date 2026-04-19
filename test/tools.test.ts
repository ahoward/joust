import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { safe_resolve, create_workspace_tools } from "../src/tools";

// --- temp workspace for testing ---

const test_dir = join(tmpdir(), `joust-tools-test-${Date.now()}`);
const src_dir = join(test_dir, "src");
const sub_dir = join(test_dir, "src", "lib");
const nm_dir = join(test_dir, "node_modules", "foo");

beforeAll(() => {
  mkdirSync(sub_dir, { recursive: true });
  mkdirSync(nm_dir, { recursive: true });

  writeFileSync(join(test_dir, "README.md"), "# Test Project\n");
  writeFileSync(join(src_dir, "main.ts"), 'export function main() {\n  console.log("hello");\n}\n');
  writeFileSync(join(src_dir, "utils.ts"), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
  writeFileSync(join(sub_dir, "helper.ts"), 'export const VERSION = "1.0.0";\n');
  writeFileSync(join(nm_dir, "index.js"), "module.exports = {};\n");

  // symlink pointing outside workspace
  try {
    symlinkSync("/etc/hostname", join(test_dir, "escape-link"));
  } catch {
    // may fail in some sandboxed environments — that's fine
  }
});

afterAll(() => {
  rmSync(test_dir, { recursive: true, force: true });
});

// --- safe_resolve ---

describe("safe_resolve", () => {
  test("allows paths inside workspace", () => {
    const result = safe_resolve(test_dir, "src/main.ts");
    expect(result).toContain("src/main.ts");
  });

  test("blocks path traversal with ../", () => {
    expect(() => safe_resolve(test_dir, "../../../etc/shadow")).toThrow("path traversal blocked");
  });

  test("blocks absolute paths outside workspace", () => {
    expect(() => safe_resolve(test_dir, "/etc/shadow")).toThrow("path traversal blocked");
  });

  test("allows workspace root itself", () => {
    const result = safe_resolve(test_dir, ".");
    expect(result).toBe(test_dir);
  });
});

// --- tool execution ---

describe("create_workspace_tools", () => {
  const tools = create_workspace_tools(test_dir);

  describe("read_file", () => {
    test("reads an existing file", async () => {
      const result = await tools.read_file.execute!({ path: "src/main.ts" }, {} as any);
      expect(result).toContain('console.log("hello")');
    });

    test("returns error for missing file", async () => {
      const result = await tools.read_file.execute!({ path: "src/nope.ts" }, {} as any);
      expect(result).toContain("error: file not found");
    });

    test("returns error for directory", async () => {
      const result = await tools.read_file.execute!({ path: "src" }, {} as any);
      expect(result).toContain("error: not a file");
    });
  });

  describe("list_files", () => {
    test("lists TypeScript files", async () => {
      const result = await tools.list_files.execute!({ pattern: "**/*.ts" }, {} as any);
      expect(result).toContain("src/main.ts");
      expect(result).toContain("src/utils.ts");
      expect(result).toContain("src/lib/helper.ts");
    });

    test("excludes node_modules", async () => {
      const result = await tools.list_files.execute!({ pattern: "**/*.js" }, {} as any);
      expect(result).not.toContain("node_modules");
    });

    test("returns message for no matches", async () => {
      const result = await tools.list_files.execute!({ pattern: "**/*.py" }, {} as any);
      expect(result).toContain("no files matched");
    });
  });

  describe("search_files", () => {
    test("finds matching content", async () => {
      const result = await tools.search_files.execute!({ pattern: "console\\.log" }, {} as any);
      expect(result).toContain("src/main.ts");
      expect(result).toContain("hello");
    });

    test("filters by glob", async () => {
      const result = await tools.search_files.execute!({ pattern: "export", glob: "**/*.ts" }, {} as any);
      expect(result).toContain("src/main.ts");
      expect(result).toContain("src/utils.ts");
    });

    test("returns message for no matches", async () => {
      const result = await tools.search_files.execute!({ pattern: "ZZZZNOTFOUND" }, {} as any);
      expect(result).toContain("no matches");
    });

    test("handles invalid regex gracefully", async () => {
      const result = await tools.search_files.execute!({ pattern: "[invalid" }, {} as any);
      expect(result).toContain("error: invalid regex");
    });

    test("excludes node_modules from search", async () => {
      const result = await tools.search_files.execute!({ pattern: "module\\.exports" }, {} as any);
      expect(result).not.toContain("node_modules");
    });
  });
});
