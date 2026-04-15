import { describe, test, expect } from "bun:test";
import { slugify, expand_env_vars, scrub_keys, to_json } from "../src/utils";

describe("slugify", () => {
  test("basic conversion", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  test("strips special characters", () => {
    expect(slugify("design a caching layer!")).toBe("design-a-caching-layer");
  });

  test("trims leading/trailing dashes", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  test("truncates to 64 chars", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(64);
  });

  test("handles empty string", () => {
    expect(slugify("")).toBe("");
  });
});

describe("expand_env_vars", () => {
  test("expands known env vars", () => {
    process.env.TEST_JOUST_VAR = "hello";
    expect(expand_env_vars("$TEST_JOUST_VAR")).toBe("hello");
    delete process.env.TEST_JOUST_VAR;
  });

  test("throws on missing env var", () => {
    expect(() => expand_env_vars("$NONEXISTENT_JOUST_VAR_XYZ")).toThrow("missing environment variable");
  });

  test("expands multiple vars", () => {
    process.env.TEST_A = "foo";
    process.env.TEST_B = "bar";
    expect(expand_env_vars("$TEST_A and $TEST_B")).toBe("foo and bar");
    delete process.env.TEST_A;
    delete process.env.TEST_B;
  });
});

describe("scrub_keys", () => {
  test("scrubs Anthropic keys", () => {
    const text = "key: sk-ant-abc123def456ghi789jkl012";
    expect(scrub_keys(text)).toBe("key: [REDACTED]");
  });

  test("scrubs OpenAI keys", () => {
    const text = "key: sk-abc123def456ghi789jkl012";
    expect(scrub_keys(text)).toBe("key: [REDACTED]");
  });

  test("scrubs Google keys", () => {
    const text = "key: AIzabc123def456ghi789jkl012";
    expect(scrub_keys(text)).toBe("key: [REDACTED]");
  });

  test("sk-ant- matched before sk- to avoid partial match", () => {
    const text = "sk-ant-abc123def456ghi789jkl012";
    const result = scrub_keys(text);
    expect(result).toBe("[REDACTED]");
    // should NOT leave "ant-..." residue
    expect(result).not.toContain("ant-");
  });

  test("leaves non-key text untouched", () => {
    const text = "hello world, no keys here";
    expect(scrub_keys(text)).toBe(text);
  });

  test("scrubs multiple keys in one string", () => {
    const text = "first: sk-ant-abc123def456ghi789jkl012 second: AIzabc123def456ghi789jkl012";
    expect(scrub_keys(text)).toBe("first: [REDACTED] second: [REDACTED]");
  });
});

describe("to_json", () => {
  test("pretty prints", () => {
    const result = to_json({ a: 1 });
    expect(result).toContain("\n");
    expect(result).toContain("  ");
  });
});
