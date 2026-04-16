import { describe, test, expect } from "bun:test";
import { slugify, expand_env_vars, scrub_keys, to_json, redact } from "../src/utils";

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

describe("redact", () => {
  test("replaces sensitive keys with [REDACTED]", () => {
    const input = { api_key: "sk-live-abc123", name: "test" };
    const output = redact(input);
    expect(output.api_key).toBe("[REDACTED]");
    expect(output.name).toBe("test");
  });

  test("handles all key variants", () => {
    const input: Record<string, unknown> = {
      api_key: "x", apiKey: "y", apikey: "z",
      token: "t", secret: "s", password: "p",
      authorization: "a", Authorization: "A",
    };
    const output = redact(input);
    for (const k of Object.keys(input)) {
      expect(output[k]).toBe("[REDACTED]");
    }
  });

  test("passes through objects with no sensitive keys", () => {
    const input = { host: "localhost", port: 3000 };
    const output = redact(input as Record<string, unknown>);
    expect(output).toEqual(input);
  });

  test("returns a new object (does not mutate input)", () => {
    const input = { api_key: "sk-live-abc123", name: "test" };
    const output = redact(input);
    expect(output).not.toBe(input);
    expect(input.api_key).toBe("sk-live-abc123");
  });

  test("handles empty object", () => {
    expect(redact({})).toEqual({});
  });

  test("does not redact substring matches", () => {
    const input: Record<string, unknown> = { key: "value", tokenizer: "bert" };
    const output = redact(input);
    expect(output.key).toBe("value");
    expect(output.tokenizer).toBe("bert");
  });
});
