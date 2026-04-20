import { describe, test, expect } from "bun:test";
import { slugify, to_json } from "../src/utils";

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

describe("to_json", () => {
  test("pretty prints", () => {
    const result = to_json({ a: 1 });
    expect(result).toContain("\n");
    expect(result).toContain("  ");
  });
});
