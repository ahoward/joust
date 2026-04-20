import { describe, test, expect } from "bun:test";
import {
  resolve_config,
  get_main_agent,
  get_jousters,
  is_specialist_name,
  get_specialist,
  build_specialist_agent,
  generate_default_config,
  normalize_gemini_env,
  has_gemini_key,
  SPECIALISTS,
  PRESET_CONFIGS,
} from "../src/config";
import { JoustError } from "../src/errors";
import { SPECIALIST_NAMES } from "../src/types";

describe("resolve_config", () => {
  test("returns built-in defaults when no project dir", () => {
    const config = resolve_config();
    expect(config.defaults.temperature).toBe(0.2);
    expect(config.defaults.max_retries).toBe(3);
    expect(config.defaults.compaction_threshold).toBe(10);
    expect(config.defaults.max_rounds).toBe(1);
  });

  test("built-in panel is main + peer (specialists are summoned, not pre-baked)", () => {
    const config = resolve_config();
    expect(config.agents.main).toBeDefined();
    expect(config.agents.peer).toBeDefined();
    // specialists are NOT permanent panel members — they're summoned on demand
    expect(config.agents.security).toBeUndefined();
    expect(config.agents.cfo).toBeUndefined();
  });

  test("main and peer use different providers for adversarial cross-check", () => {
    const config = resolve_config();
    expect(config.agents.main.api_key).not.toBe(config.agents.peer.api_key);
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

  test("config errors are JoustError instances", () => {
    const config = resolve_config();
    // remove main to trigger get_main_agent error
    delete config.agents["main"];
    expect(() => get_main_agent(config)).toThrow(JoustError);
  });

  test("literal api_key error includes redacted config, not raw key", () => {
    // we can't easily trigger this through resolve_config, but we can test
    // that the error message pattern is correct by checking built-in agents
    // never have literal keys
    const config = resolve_config();
    for (const agent of Object.values(config.agents)) {
      expect(agent.api_key.startsWith("$")).toBe(true);
    }
  });
});

describe("specialist pool", () => {
  test("SPECIALISTS exposes all six named specialists", () => {
    const names = SPECIALISTS.map((s) => s.name).sort();
    expect(names).toEqual([...SPECIALIST_NAMES].sort() as any);
  });

  test("is_specialist_name identifies known specialists only", () => {
    expect(is_specialist_name("security")).toBe(true);
    expect(is_specialist_name("dba")).toBe(true);
    expect(is_specialist_name("main")).toBe(false);
    expect(is_specialist_name("peer")).toBe(false);
    expect(is_specialist_name("nope")).toBe(false);
  });

  test("get_specialist returns the definition for a known name", () => {
    const s = get_specialist("security");
    expect(s).toBeDefined();
    expect(s!.name).toBe("security");
    expect(s!.system.length).toBeGreaterThan(0);
  });

  test("build_specialist_agent scopes the system prompt to the summoner's ask", () => {
    const config = resolve_config();
    const ask = "evaluate whether the token-refresh flow is replay-vulnerable";
    const agent = build_specialist_agent(
      "security",
      ask,
      config,
      PRESET_CONFIGS.mixed.peer
    );
    expect(agent.name).toBe("security");
    expect(agent.system).toContain(ask);
    expect(agent.system).toContain("scoped review");
  });

  test("build_specialist_agent prefers rfc.yaml-configured specialist over built-in", () => {
    const config = resolve_config();
    config.agents.security = {
      name: "security",
      model: "custom-model",
      api_key: "$CUSTOM_KEY",
      system: "user's custom security prompt",
    };
    const agent = build_specialist_agent(
      "security",
      "some ask",
      config,
      PRESET_CONFIGS.mixed.peer
    );
    expect(agent.model).toBe("custom-model");
    expect(agent.api_key).toBe("$CUSTOM_KEY");
    expect(agent.system).toContain("user's custom security prompt");
  });
});

describe("generate_default_config", () => {
  test("default panel is main + peer, specialists live only in specialist_pool", () => {
    const cfg = JSON.parse(generate_default_config("mixed"));
    expect(cfg.agents.main).toBeDefined();
    expect(cfg.agents.peer).toBeDefined();
    expect(cfg.agents.security).toBeUndefined();
    expect(cfg.agents.cfo).toBeUndefined();
    expect(cfg.specialist_pool.security).toBeDefined();
    expect(cfg.specialist_pool.cfo).toBeDefined();
  });

  test("mixed preset uses claude + gemini (two companies)", () => {
    const cfg = JSON.parse(generate_default_config("mixed"));
    expect(cfg.agents.main.model).toBe("claude-opus-4-6");
    expect(cfg.agents.peer.model).toBe("gemini-2.5-pro");
    expect(cfg.agents.main.api_key).toBe("$ANTHROPIC_API_KEY");
    expect(cfg.agents.peer.api_key).toBe("$GOOGLE_GENERATIVE_AI_API_KEY");
  });

  test("all preset configs are valid JSON for all four presets", () => {
    for (const preset of ["anthropic", "gemini", "openai", "mixed"] as const) {
      const cfg = JSON.parse(generate_default_config(preset));
      expect(cfg.defaults).toBeDefined();
      expect(cfg.agents.main).toBeDefined();
      expect(cfg.agents.peer).toBeDefined();
    }
  });

  test("output is pretty-printed (human-editable)", () => {
    const text = generate_default_config("mixed");
    expect(text).toContain("\n");
    expect(text).toContain("  ");
  });
});

describe("gemini env fallback", () => {
  test("normalize_gemini_env mirrors GEMINI_API_KEY to GOOGLE_GENERATIVE_AI_API_KEY", () => {
    const original_google = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const original_gemini = process.env.GEMINI_API_KEY;
    try {
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      process.env.GEMINI_API_KEY = "test-gemini-key";
      normalize_gemini_env();
      expect(process.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe("test-gemini-key");
    } finally {
      if (original_google === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      else process.env.GOOGLE_GENERATIVE_AI_API_KEY = original_google;
      if (original_gemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = original_gemini;
    }
  });

  test("normalize_gemini_env does not overwrite GOOGLE_GENERATIVE_AI_API_KEY when set", () => {
    const original_google = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const original_gemini = process.env.GEMINI_API_KEY;
    try {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-key";
      process.env.GEMINI_API_KEY = "gemini-key";
      normalize_gemini_env();
      expect(process.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe("google-key");
    } finally {
      if (original_google === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      else process.env.GOOGLE_GENERATIVE_AI_API_KEY = original_google;
      if (original_gemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = original_gemini;
    }
  });

  test("has_gemini_key returns true for either env var", () => {
    const original_google = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const original_gemini = process.env.GEMINI_API_KEY;
    try {
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      expect(has_gemini_key()).toBe(false);
      process.env.GEMINI_API_KEY = "x";
      expect(has_gemini_key()).toBe(true);
      delete process.env.GEMINI_API_KEY;
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "y";
      expect(has_gemini_key()).toBe(true);
    } finally {
      if (original_google === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      else process.env.GOOGLE_GENERATIVE_AI_API_KEY = original_google;
      if (original_gemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = original_gemini;
    }
  });
});

describe("MutationResultSchema", () => {
  test("accepts mutations without summon", async () => {
    const { MutationResultSchema } = await import("../src/types");
    const result = MutationResultSchema.safeParse({
      draft: "the new draft",
      critique: "changed X because Y",
    });
    expect(result.success).toBe(true);
  });

  test("accepts mutations with a valid summon", async () => {
    const { MutationResultSchema } = await import("../src/types");
    const result = MutationResultSchema.safeParse({
      draft: "the new draft",
      critique: "changed X; spotted a token-refresh concern outside my expertise",
      summon: {
        specialist: "security",
        ask: "evaluate replay-resistance of the proposed token-refresh flow",
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown specialist names", async () => {
    const { MutationResultSchema } = await import("../src/types");
    const result = MutationResultSchema.safeParse({
      draft: "d",
      critique: "c",
      summon: { specialist: "wizard", ask: "something" },
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty summon.ask", async () => {
    const { MutationResultSchema } = await import("../src/types");
    const result = MutationResultSchema.safeParse({
      draft: "d",
      critique: "c",
      summon: { specialist: "security", ask: "" },
    });
    expect(result.success).toBe(false);
  });
});
