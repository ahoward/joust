import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { expand_env_vars, load_config } from "../src/utils";
import { resolve_config } from "../src/config";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("expand_env_vars", () => {
  const origEnv = process.env.TEST_VAR;

  beforeEach(() => {
    process.env.TEST_VAR = "secret_value";
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.TEST_VAR;
    } else {
      process.env.TEST_VAR = origEnv;
    }
  });

  test("resolves known env vars", () => {
    expect(expand_env_vars("$TEST_VAR")).toBe("secret_value");
  });

  test("throws on missing env vars", () => {
    expect(() => expand_env_vars("$NONEXISTENT_VAR_XYZ")).toThrow(
      "missing environment variable: $NONEXISTENT_VAR_XYZ"
    );
  });

  test("does not expand bare text without $", () => {
    expect(expand_env_vars("just text")).toBe("just text");
  });
});

describe("load_config (Issue #12 fix)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "joust-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("does NOT expand env vars in YAML body — $ in system prompt is preserved", () => {
    const yamlContent = [
      "defaults:",
      "  temperature: 0.2",
      "",
      "agents:",
      "  main:",
      "    model: claude-sonnet-4-6",
      "    api_key: $ANTHROPIC_API_KEY",
      "    system: >",
      "      This costs $500/month to run.",
      "",
    ].join("\n");

    const configPath = join(tmpDir, "rfc.yaml");
    writeFileSync(configPath, yamlContent);

    // Should NOT throw "missing environment variable" for $500
    const config = load_config(configPath) as any;
    expect(config.agents.main.system).toContain("$500/month");
    // api_key should still be raw $ENV_VAR reference
    expect(config.agents.main.api_key).toBe("$ANTHROPIC_API_KEY");
  });

  test("preserves text like 'earned $1000 today' in system prompts", () => {
    const yamlContent = [
      "agents:",
      "  main:",
      "    model: claude-sonnet-4-6",
      "    api_key: $ANTHROPIC_API_KEY",
      "    system: I earned $1000 and spent $50 on $ITEM today",
      "",
    ].join("\n");

    const configPath = join(tmpDir, "rfc.yaml");
    writeFileSync(configPath, yamlContent);

    const config = load_config(configPath) as any;
    // All dollar amounts preserved as literal text
    expect(config.agents.main.system).toBe("I earned $1000 and spent $50 on $ITEM today");
  });
});

describe("resolve_config (Issue #10 fix)", () => {
  let tmpDir: string;
  const origKey = process.env.TEST_API_KEY;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "joust-test-"));
    process.env.TEST_API_KEY = "sk-ant-real-secret-key-12345";
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origKey === undefined) {
      delete process.env.TEST_API_KEY;
    } else {
      process.env.TEST_API_KEY = origKey;
    }
  });

  test("api_key is stored as raw $ENV_VAR, NOT resolved to plaintext", () => {
    const yamlContent = [
      "agents:",
      "  main:",
      "    model: claude-sonnet-4-6",
      "    api_key: $TEST_API_KEY",
      "    system: test",
      "",
    ].join("\n");

    const configPath = join(tmpDir, "rfc.yaml");
    mkdirSync(join(tmpDir, ".joust"), { recursive: true });
    writeFileSync(configPath, yamlContent);

    const config = resolve_config(tmpDir);
    // api_key should be the raw reference, NOT the secret value
    expect(config.agents["main"].api_key).toBe("$TEST_API_KEY");
    // Should NOT contain the actual secret
    expect(config.agents["main"].api_key).not.toContain("sk-ant-real-secret");
  });

  test("JSON.stringify(config) does NOT leak API keys", () => {
    const yamlContent = [
      "agents:",
      "  main:",
      "    model: claude-sonnet-4-6",
      "    api_key: $TEST_API_KEY",
      "    system: test",
      "",
    ].join("\n");

    const configPath = join(tmpDir, "rfc.yaml");
    writeFileSync(configPath, yamlContent);

    const config = resolve_config(tmpDir);
    const serialized = JSON.stringify(config);

    // The actual secret must NOT appear in serialized config
    expect(serialized).not.toContain("sk-ant-real-secret-key-12345");
    // The raw reference should be there
    expect(serialized).toContain("$TEST_API_KEY");
  });

  test("stack traces with config objects do NOT leak API keys", () => {
    const yamlContent = [
      "agents:",
      "  main:",
      "    model: claude-sonnet-4-6",
      "    api_key: $TEST_API_KEY",
      "    system: test",
      "",
    ].join("\n");

    const configPath = join(tmpDir, "rfc.yaml");
    writeFileSync(configPath, yamlContent);

    const config = resolve_config(tmpDir);

    // Simulate what happens when config appears in error messages
    const errorDump = `Config: ${JSON.stringify(config)}`;
    expect(errorDump).not.toContain("sk-ant-real-secret-key-12345");
  });
});
