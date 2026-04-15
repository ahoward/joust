import { describe, test, expect } from "bun:test";
import { resolve_config, get_main_agent, get_jousters } from "../src/config";

describe("resolve_config", () => {
  test("returns built-in defaults when no project dir", () => {
    const config = resolve_config();
    expect(config.defaults.temperature).toBe(0.2);
    expect(config.defaults.max_retries).toBe(3);
    expect(config.defaults.compaction_threshold).toBe(10);
    expect(config.defaults.max_rounds).toBe(1);
  });

  test("built-in agents include main, security, cfo", () => {
    const config = resolve_config();
    expect(config.agents.main).toBeDefined();
    expect(config.agents.security).toBeDefined();
    expect(config.agents.cfo).toBeDefined();
  });

  test("api_key is stored as raw $VAR reference, never resolved", () => {
    const config = resolve_config();
    for (const agent of Object.values(config.agents)) {
      expect(agent.api_key).toStartWith("$");
      // must not contain the actual key value
      expect(agent.api_key).not.toContain("sk-");
      expect(agent.api_key).not.toContain("AIza");
    }
  });

  test("get_main_agent returns main", () => {
    const config = resolve_config();
    const main = get_main_agent(config);
    expect(main.name).toBe("main");
  });

  test("get_jousters excludes main", () => {
    const config = resolve_config();
    const jousters = get_jousters(config);
    expect(jousters.every((j) => j.name !== "main")).toBe(true);
    expect(jousters.length).toBeGreaterThan(0);
  });
});
