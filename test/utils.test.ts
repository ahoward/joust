import { describe, test, expect } from "bun:test";
import { slugify, scrub_keys, to_json, redact } from "../src/utils";

describe("slugify", () => {
  const date = new Date().toISOString().slice(0, 10);

  test("date-prefixed with meaningful words", () => {
    const result = slugify("Hello World");
    expect(result).toBe(`${date}--hello-world`);
  });

  test("strips stop words", () => {
    const result = slugify("design a caching layer for mobile APIs");
    expect(result).toBe(`${date}--caching-layer-mobile-apis`);
  });

  test("limits to 6 meaningful words", () => {
    const result = slugify("realtime bidding engine must handle 100k qps vendor lock");
    const words = result.replace(`${date}--`, "").split("-");
    expect(words.length).toBeLessThanOrEqual(6);
  });

  test("falls back to 'joust' for empty input", () => {
    expect(slugify("")).toBe(`${date}--joust`);
  });

  test("starts with date prefix", () => {
    expect(slugify("anything")).toMatch(/^\d{4}-\d{2}-\d{2}--/);
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
