import { describe, test, expect } from "bun:test";
import { ZodError, z } from "zod";
import {
  backoff_ms,
  is_rate_limit,
  is_server_error,
  is_parse_error,
  is_transient,
  parse_duration,
} from "../src/tank";

describe("backoff_ms", () => {
  test("exponential growth", () => {
    expect(backoff_ms(1)).toBe(2000);
    expect(backoff_ms(2)).toBe(4000);
    expect(backoff_ms(3)).toBe(8000);
  });

  test("caps at 60s", () => {
    expect(backoff_ms(10)).toBe(60_000);
    expect(backoff_ms(100)).toBe(60_000);
  });
});

describe("error classification", () => {
  test("is_rate_limit detects 429 status", () => {
    expect(is_rate_limit({ status: 429 })).toBe(true);
    expect(is_rate_limit({ statusCode: 429 })).toBe(true);
    expect(is_rate_limit({ response: { status: 429 } })).toBe(true);
  });

  test("is_rate_limit detects message patterns", () => {
    expect(is_rate_limit({ message: "rate limit exceeded" })).toBe(true);
    expect(is_rate_limit({ message: "too many requests" })).toBe(true);
  });

  test("is_server_error detects 5xx", () => {
    expect(is_server_error({ status: 500 })).toBe(true);
    expect(is_server_error({ status: 503 })).toBe(true);
    expect(is_server_error({ status: 400 })).toBe(false);
    expect(is_server_error({ status: 429 })).toBe(false);
  });

  test("is_parse_error detects ZodError", () => {
    try {
      z.string().parse(123);
    } catch (e) {
      expect(is_parse_error(e)).toBe(true);
    }
  });

  test("is_parse_error detects NoObjectGeneratedError by name", () => {
    const err = new Error("no object");
    (err as any).name = "NoObjectGeneratedError";
    expect(is_parse_error(err)).toBe(true);
  });

  test("is_parse_error rejects normal errors", () => {
    expect(is_parse_error(new Error("connection refused"))).toBe(false);
  });

  test("is_transient covers all retriable categories", () => {
    expect(is_transient({ status: 429 })).toBe(true);
    expect(is_transient({ status: 500 })).toBe(true);
    const err = new Error("no object");
    (err as any).name = "NoObjectGeneratedError";
    expect(is_transient(err)).toBe(true);
    expect(is_transient(new Error("fatal"))).toBe(false);
  });
});

describe("parse_duration", () => {
  test("parses seconds", () => {
    expect(parse_duration("300s")).toBe(300_000);
  });

  test("parses minutes", () => {
    expect(parse_duration("45m")).toBe(45 * 60 * 1000);
  });

  test("parses hours", () => {
    expect(parse_duration("1h")).toBe(60 * 60 * 1000);
  });

  test("rejects invalid", () => {
    expect(() => parse_duration("foo")).toThrow("invalid duration");
    expect(() => parse_duration("10x")).toThrow("invalid duration");
  });
});
