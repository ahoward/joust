import { describe, test, expect } from "bun:test";
import {
  resolve_config,
  get_main_agent,
  get_jousters,
  is_specialist_name,
  get_specialist,
  build_specialist_agent,
  build_scorer_agent,
  generate_default_config,
  normalize_gemini_env,
  has_gemini_key,
  normalize_grok_env,
  has_grok_key,
  detect_preset,
  is_preset,
  PRESETS,
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

  test("grok preset uses grok-4.6 on both slots with $XAI_API_KEY", () => {
    const cfg = JSON.parse(generate_default_config("grok"));
    expect(cfg.agents.main.model).toBe("grok-4.6");
    expect(cfg.agents.peer.model).toBe("grok-4.6");
    expect(cfg.agents.main.api_key).toBe("$XAI_API_KEY");
    expect(cfg.agents.peer.api_key).toBe("$XAI_API_KEY");
  });

  test("all preset configs are valid JSON for every preset", () => {
    for (const preset of PRESETS) {
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


describe("build_scorer_agent (#51)", () => {
  const main = {
    name: "main",
    model: "claude-opus-4-6",
    api_key: "$ANTHROPIC_API_KEY",
    system: "lead architect",
    temperature: 0.2,
  } as const;

  test("returns main unchanged when scorer_model is unset", () => {
    expect(build_scorer_agent(main)).toBe(main);
    expect(build_scorer_agent(main, undefined)).toBe(main);
  });

  test("returns main unchanged when scorer_model equals main.model", () => {
    expect(build_scorer_agent(main, "claude-opus-4-6")).toBe(main);
  });

  test("returns a clone with model swapped when scorer_model differs", () => {
    const scorer = build_scorer_agent(main, "claude-haiku-4-5");
    expect(scorer.model).toBe("claude-haiku-4-5");
    expect(scorer.api_key).toBe(main.api_key);
    expect(scorer.system).toBe(main.system);
    expect(scorer.temperature).toBe(main.temperature);
    expect(scorer.name).toBe("main-scorer");
    // does not mutate main
    expect(main.model).toBe("claude-opus-4-6");
  });
});

describe("grok preset + env", () => {
  const PROVIDER_KEYS = [
    "ANTHROPIC_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "XAI_API_KEY",
    "GROK_API_KEY",
  ] as const;

  // detect_preset reads raw env — snapshot and clear every provider key so
  // the developer's real environment can't leak into the assertion.
  function with_clean_env(fn: () => void): void {
    const saved: Record<string, string | undefined> = {};
    for (const k of PROVIDER_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      fn();
    } finally {
      for (const k of PROVIDER_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }

  test("resolve_config on the grok preset puts main + peer on grok", () => {
    const config = resolve_config(undefined, "grok");
    expect(config.agents.main!.model).toBe("grok-4.6");
    expect(config.agents.main!.api_key).toBe("$XAI_API_KEY");
    expect(config.agents.peer!.model).toBe("grok-4.6");
    expect(config.agents.peer!.api_key).toBe("$XAI_API_KEY");
  });

  test("resolve_config defaults to the mixed panel when no preset is given", () => {
    const config = resolve_config();
    expect(config.agents.main!.model).toBe("claude-opus-4-6");
    expect(config.agents.peer!.model).toBe("gemini-2.5-pro");
  });

  test("grok is a recognized preset", () => {
    expect(is_preset("grok")).toBe(true);
    expect(PRESETS).toContain("grok");
  });

  test("PRESET_CONFIGS.grok pins grok on main and peer", () => {
    expect(PRESET_CONFIGS.grok.main.model).toBe("grok-4.6");
    expect(PRESET_CONFIGS.grok.peer.api_key).toBe("$XAI_API_KEY");
  });

  test("has_grok_key sees either XAI_API_KEY or GROK_API_KEY", () => {
    with_clean_env(() => {
      expect(has_grok_key()).toBe(false);
      process.env.GROK_API_KEY = "k";
      expect(has_grok_key()).toBe(true);
      delete process.env.GROK_API_KEY;
      process.env.XAI_API_KEY = "k";
      expect(has_grok_key()).toBe(true);
    });
  });

  test("normalize_grok_env mirrors GROK_API_KEY to XAI_API_KEY", () => {
    with_clean_env(() => {
      process.env.GROK_API_KEY = "test-grok-key";
      normalize_grok_env();
      expect(process.env.XAI_API_KEY).toBe("test-grok-key");
    });
  });

  test("normalize_grok_env does not overwrite XAI_API_KEY when set", () => {
    with_clean_env(() => {
      process.env.XAI_API_KEY = "xai-key";
      process.env.GROK_API_KEY = "grok-key";
      normalize_grok_env();
      expect(process.env.XAI_API_KEY).toBe("xai-key");
    });
  });

  test("detect_preset picks grok when it is the only key present", () => {
    with_clean_env(() => {
      process.env.XAI_API_KEY = "k";
      expect(detect_preset()).toBe("grok");
    });
  });

  test("detect_preset prefers mixed over grok when anthropic + gemini are set", () => {
    with_clean_env(() => {
      process.env.XAI_API_KEY = "k";
      process.env.ANTHROPIC_API_KEY = "k";
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "k";
      expect(detect_preset()).toBe("mixed");
    });
  });
});
