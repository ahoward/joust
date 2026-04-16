import { describe, test, expect } from "bun:test";
import { JoustError, JoustUserError } from "../src/errors";

describe("JoustError", () => {
  test("has default exit code 1", () => {
    const err = new JoustError("boom");
    expect(err.exit_code).toBe(1);
    expect(err.message).toBe("boom");
    expect(err.name).toBe("JoustError");
  });

  test("accepts custom exit code", () => {
    const err = new JoustError("bad config", 2);
    expect(err.exit_code).toBe(2);
  });

  test("is an instance of Error", () => {
    const err = new JoustError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(JoustError);
  });
});

describe("JoustUserError", () => {
  test("has exit code 1", () => {
    const err = new JoustUserError("bad input");
    expect(err.exit_code).toBe(1);
    expect(err.name).toBe("JoustUserError");
  });

  test("extends JoustError", () => {
    const err = new JoustUserError("bad input");
    expect(err).toBeInstanceOf(JoustError);
    expect(err).toBeInstanceOf(Error);
  });

  test("instanceof ordering: JoustUserError before JoustError", () => {
    const err = new JoustUserError("test");
    // both checks are true, but subclass check must come first
    expect(err instanceof JoustUserError).toBe(true);
    expect(err instanceof JoustError).toBe(true);
  });
});
