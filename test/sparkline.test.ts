import { describe, test, expect } from "bun:test";
import { sparkline } from "../src/sparkline.ts";

describe("sparkline", () => {
  test("empty series -> empty string", () => {
    expect(sparkline([])).toBe("");
  });

  test("single value -> single block", () => {
    expect(sparkline([0.5]).length).toBe(1);
  });

  test("all-equal series -> uniform mid blocks", () => {
    const out = sparkline([0.7, 0.7, 0.7, 0.7]);
    expect(out.length).toBe(4);
    // every position should be the same character
    expect(new Set([...out]).size).toBe(1);
  });

  test("strictly ascending series ends at the highest block", () => {
    const out = sparkline([0.1, 0.5, 0.9]);
    expect(out.length).toBe(3);
    // last char is '█'
    expect(out[out.length - 1]).toBe("█");
    // first char is '▁'
    expect(out[0]).toBe("▁");
  });

  test("strictly descending series starts at the highest block", () => {
    const out = sparkline([0.9, 0.5, 0.1]);
    expect(out[0]).toBe("█");
    expect(out[out.length - 1]).toBe("▁");
  });

  test("output length matches input length", () => {
    expect(sparkline([1, 2, 3, 4, 5]).length).toBe(5);
    expect(sparkline([0.1]).length).toBe(1);
    expect(sparkline([0.5, 0.6, 0.7, 0.8, 0.9, 1.0]).length).toBe(6);
  });

  test("handles negative values (range alone matters)", () => {
    const out = sparkline([-1, 0, 1]);
    expect(out.length).toBe(3);
    expect(out[0]).toBe("▁");
    expect(out[2]).toBe("█");
  });
});
