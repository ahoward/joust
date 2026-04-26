import { existsSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { load_config, to_json } from "./utils";
import { JoustError } from "./errors";
import type { JoustConfig, AgentConfig, JoustDefaults, SpecialistName } from "./types";
import { SPECIALIST_NAMES } from "./types";

// --- built-in defaults ---

const DEFAULT_DEFAULTS: JoustDefaults = {
  temperature: 0.2,
  max_retries: 3,
  compaction_threshold: 10,
  max_rounds: 1,
  plateau_epsilon: 0.02,
  plateau_k: 2,
};

// default panel: two peer lead architects. same system prompt, different
// providers. specialists are summoned on demand by either peer, not
// pre-baked into the panel.
const BUILTIN_AGENTS: Record<string, Omit<AgentConfig, "name">> = {
  main: {
    model: "claude-opus-4-6",
    api_key: "$ANTHROPIC_API_KEY",
    system:
      "You are a senior lead architect. You own the core vision. " +
      "Before any peer review, define strict RFC 2119 invariants (MUST, SHOULD, MUST NOT). " +
      "Protect these invariants across all revisions. " +
      "When a concern arises that is clearly outside your expertise (security, cost, database, performance, UX, or legal/compliance), " +
      "summon the relevant specialist with a specific, scoped question.",
  },
  peer: {
    model: "gemini-2.5-pro",
    api_key: "$GOOGLE_GENERATIVE_AI_API_KEY",
    system:
      "You are a senior lead architect. You own the core vision. " +
      "Before any peer review, define strict RFC 2119 invariants (MUST, SHOULD, MUST NOT). " +
      "Protect these invariants across all revisions. " +
      "When a concern arises that is clearly outside your expertise (security, cost, database, performance, UX, or legal/compliance), " +
      "summon the relevant specialist with a specific, scoped question.",
  },
};

// --- resolve config ---

function expand_agent_config(name: string, raw: Record<string, any>, defaults: JoustDefaults): AgentConfig {
  const raw_key = raw.api_key ?? "$ANTHROPIC_API_KEY";

  // api_key must be an env var reference — never a literal key
  if (!raw_key.startsWith("$")) {
    throw new JoustError(
      `agent '${name}' api_key must be an env var reference like $ANTHROPIC_API_KEY, got literal string. ` +
      `Never put raw API keys in config files.`
    );
  }

  return {
    name,
    model: raw.model ?? "claude-sonnet-4-6",
    api_key: raw_key, // store raw $VAR reference — resolved lazily in get_model()
    system: raw.system ?? "",
    temperature: raw.temperature ?? defaults.temperature,
  };
}

export function resolve_config(project_dir?: string): JoustConfig {
  let merged_defaults = { ...DEFAULT_DEFAULTS };
  let merged_agents: Record<string, any> = {};

  // layer 1: built-in agents
  for (const [name, agent] of Object.entries(BUILTIN_AGENTS)) {
    merged_agents[name] = { ...agent };
  }

  // layer 2: user global config (~/.joust/config.json)
  const global_path = join(homedir(), ".joust", "config.json");
  if (existsSync(global_path)) {
    const global_cfg = load_config(global_path) as any;
    if (global_cfg?.defaults) {
      merged_defaults = { ...merged_defaults, ...global_cfg.defaults };
    }
    if (global_cfg?.agents) {
      merged_agents = { ...merged_agents, ...global_cfg.agents };
    }
  }

  // layer 3: project config (config.json)
  // if project defines agents, it REPLACES the built-in set (not merge).
  // the user is being explicit about their panel.
  if (project_dir) {
    const project_path = join(project_dir, "config.json");
    if (existsSync(project_path)) {
      const project_cfg = load_config(project_path) as any;
      if (project_cfg?.defaults) {
        merged_defaults = { ...merged_defaults, ...project_cfg.defaults };
      }
      if (project_cfg?.agents) {
        merged_agents = project_cfg.agents;
      }
    }
  }

  // resolve workspace — defaults to project dir
  if (!merged_defaults.workspace && project_dir) {
    merged_defaults.workspace = resolve(project_dir);
  } else if (merged_defaults.workspace && project_dir) {
    const ws = resolve(project_dir, merged_defaults.workspace);
    if (!existsSync(ws) || !statSync(ws).isDirectory()) {
      throw new JoustError(`workspace directory does not exist: ${ws}`);
    }
    merged_defaults.workspace = ws;
  } else if (merged_defaults.workspace && !project_dir) {
    const ws = resolve(merged_defaults.workspace);
    if (!existsSync(ws) || !statSync(ws).isDirectory()) {
      throw new JoustError(`workspace directory does not exist: ${ws}`);
    }
    merged_defaults.workspace = ws;
  }

  // expand all agent configs
  const agents: Record<string, AgentConfig> = {};
  for (const [name, raw] of Object.entries(merged_agents)) {
    agents[name] = expand_agent_config(name, raw as Record<string, any>, merged_defaults);
  }

  return { defaults: merged_defaults, agents };
}

// --- get main agent ---

export function get_main_agent(config: JoustConfig): AgentConfig {
  const main = config.agents["main"];
  if (!main) {
    throw new JoustError("config must define a 'main' agent");
  }
  return main;
}

// --- get jousters (all agents except main) ---

export function get_jousters(config: JoustConfig): AgentConfig[] {
  return Object.values(config.agents).filter((a) => a.name !== "main");
}

// --- scorer agent (#51) ---
//
// when defaults.scorer_model is set, strategy score() calls use a
// cloned main agent with the model field overridden. bootstrap stays
// on real main. api_key, system, temperature inherit from main —
// scorer_model is a model-id swap only.
//
// returns main unchanged when scorer_model is null/unset, so callers
// can blindly thread `build_scorer_agent(main, cfg.scorer_model)` and
// get the right behavior either way.
export function build_scorer_agent(main: AgentConfig, scorer_model?: string): AgentConfig {
  if (!scorer_model || scorer_model === main.model) return main;
  return {
    ...main,
    name: `${main.name}-scorer`,
    model: scorer_model,
  };
}

// --- generate default rfc.yaml content ---

// --- presets ---

export const PRESETS = ["anthropic", "gemini", "openai", "mixed"] as const;
export type Preset = (typeof PRESETS)[number];

export function is_preset(s: string): s is Preset {
  return (PRESETS as readonly string[]).includes(s);
}

export function has_gemini_key(): boolean {
  return !!(process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY);
}

// gemini provider reads GOOGLE_GENERATIVE_AI_API_KEY. if the user has set
// GEMINI_API_KEY instead (common in older scripts), mirror it at startup so
// we don't force them to rename env vars.
export function normalize_gemini_env(): void {
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_API_KEY) {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
  }
}

export function detect_preset(): Preset {
  const has_anthropic = !!process.env.ANTHROPIC_API_KEY;
  const has_gemini = has_gemini_key();
  const has_openai = !!process.env.OPENAI_API_KEY;

  // two-company default: Claude + Gemini beats single-provider
  if (has_anthropic && has_gemini) return "mixed";
  if (has_gemini && !has_anthropic) return "gemini";
  if (has_openai && !has_anthropic && !has_gemini) return "openai";
  return "anthropic"; // default — will fail at call time with a clear error if key is missing
}

// --- provider model assignment per preset ---

export interface ProviderPick {
  model: string;
  api_key: string;
}

// two slots per preset: main (one lead architect) + peer (the other lead,
// also used as provider for summoned specialists).
interface PresetConfig {
  main: ProviderPick;
  peer: ProviderPick;
}

const ANTHROPIC_OPUS:   ProviderPick = { model: "claude-opus-4-6",   api_key: "$ANTHROPIC_API_KEY" };
const ANTHROPIC_SONNET: ProviderPick = { model: "claude-sonnet-4-6", api_key: "$ANTHROPIC_API_KEY" };
const GEMINI_PRO:       ProviderPick = { model: "gemini-2.5-pro",    api_key: "$GOOGLE_GENERATIVE_AI_API_KEY" };
const OPENAI_GPT4O:     ProviderPick = { model: "gpt-4o",            api_key: "$OPENAI_API_KEY" };

export const PRESET_CONFIGS: Record<Preset, PresetConfig> = {
  // two-company default — claude + gemini. adversarial because they're
  // from different companies, not because of costume personas.
  mixed:     { main: ANTHROPIC_OPUS, peer: GEMINI_PRO       },
  // single-provider fallbacks (loses the cross-company check)
  anthropic: { main: ANTHROPIC_OPUS, peer: ANTHROPIC_SONNET },
  gemini:    { main: GEMINI_PRO,     peer: GEMINI_PRO       },
  openai:    { main: OPENAI_GPT4O,   peer: OPENAI_GPT4O     },
};

export function preset_peer_pick(preset: Preset): ProviderPick {
  return PRESET_CONFIGS[preset].peer;
}

// --- specialist pool ---
// specialists are NOT part of the default panel. A lead architect (main or
// peer) summons one on demand during a mutation turn when a concern arises
// that is clearly outside their expertise. Each specialist runs once per
// summon, scoped to the specific `ask` from the summoner.

export interface Specialist {
  name: SpecialistName;
  summary: string; // one-line hint shown to the lead architects
  system: string;  // agent system prompt when summoned
}

export const SPECIALISTS: Specialist[] = [
  {
    name: "security",
    summary: "attack surface, authn/authz, secrets, injection, tenant isolation, supply chain",
    system:
      "You are a ruthless security auditor. You have been summoned for a\n" +
      "one-shot, scoped review. Focus only on the asked question.\n" +
      "You MUST respect the invariants.",
  },
  {
    name: "cfo",
    summary: "cost, margin, vendor lock-in, commit tiers, cost of ownership at scale",
    system:
      "You are the CFO. You have been summoned for a one-shot, scoped review.\n" +
      "Focus only on the asked question. You MUST respect the invariants.",
  },
  {
    name: "dba",
    summary: "schemas, indexes, migrations, query patterns, consistency, durability",
    system:
      "You are a veteran DBA. You have been summoned for a one-shot, scoped review.\n" +
      "Focus only on the asked question. You MUST respect the invariants.",
  },
  {
    name: "perf",
    summary: "latency, throughput, hot paths, caching, capacity planning, SLOs",
    system:
      "You are a performance engineer. You have been summoned for a one-shot,\n" +
      "scoped review. Focus only on the asked question. You MUST respect the invariants.",
  },
  {
    name: "ux",
    summary: "user flows, error states, accessibility, progressive disclosure",
    system:
      "You are a UX lead. You have been summoned for a one-shot, scoped review.\n" +
      "Focus only on the asked question. You MUST respect the invariants.",
  },
  {
    name: "legal",
    summary: "privacy/PII, data retention, licensing, regulatory compliance (GDPR, HIPAA, SOC2)",
    system:
      "You are a pragmatic legal/compliance reviewer. You have been summoned for\n" +
      "a one-shot, scoped review. Focus only on the asked question.\n" +
      "You MUST respect the invariants.",
  },
];

export function is_specialist_name(s: string): s is SpecialistName {
  return (SPECIALIST_NAMES as readonly string[]).includes(s);
}

export function get_specialist(name: string): Specialist | undefined {
  return SPECIALISTS.find((s) => s.name === name);
}

// --- get the peers (main and any named peer) and specialists currently configured ---

// peers are the lead architects that always run — default is main + peer.
// any agent in rfc.yaml that isn't a known specialist name is treated as a peer.
export function get_peer_agents(config: JoustConfig): AgentConfig[] {
  return Object.values(config.agents).filter((a) => !is_specialist_name(a.name));
}

// specialists configured inline in rfc.yaml — these are the summonable pool
// available to this run. Defaults to the full pool when not listed in config.
export function get_configured_specialists(config: JoustConfig): AgentConfig[] {
  return Object.values(config.agents).filter((a) => is_specialist_name(a.name));
}

// build an AgentConfig for a summoned specialist. prefers user-configured
// specialist from rfc.yaml (so model/system overrides are honored); falls back
// to built-in pool definition using the peer's provider pick.
export function build_specialist_agent(
  name: SpecialistName,
  ask: string,
  config: JoustConfig,
  fallback_pick: ProviderPick
): AgentConfig {
  const configured = config.agents[name];
  const spec = get_specialist(name);
  if (!spec) throw new JoustError(`unknown specialist: ${name}`);

  const base: AgentConfig = configured ?? {
    name,
    model: fallback_pick.model,
    api_key: fallback_pick.api_key,
    system: spec.system,
    temperature: config.defaults.temperature,
  };

  // append the summoner's ask so the specialist's review is scoped to exactly
  // what was requested — not a general wide-area review.
  return {
    ...base,
    system: [
      base.system,
      "",
      "You have been summoned for a specific, scoped review.",
      "Your scope for this review:",
      `  ${ask}`,
      "",
      "Stay narrowly focused on that scope. Do not rewrite the draft wholesale.",
      "Only mutate what is necessary to address the scoped question.",
    ].join("\n"),
  };
}

const SYSTEM_PEER =
  "You are a senior lead architect. You own the core vision.\n" +
  "Before any peer review, define strict RFC 2119 invariants\n" +
  "(MUST, SHOULD, MUST NOT). Protect these invariants across all revisions.\n" +
  "\n" +
  "When a concern arises that is clearly outside your expertise\n" +
  "(security, cost, database, performance, UX, or legal/compliance), summon\n" +
  "the relevant specialist via the `summon` field with a specific, scoped\n" +
  "question. Do not summon for routine concerns — only when the question\n" +
  "genuinely warrants a specialist's eye.";

// generate_default_config emits config.json with the default panel
// (main + peer). The `specialist_pool` block is informational only — a hint
// showing what the lead architects can summon on demand. To pin a specialist
// as a permanent panel member, move its entry into `agents`.
export function generate_default_config(preset: Preset = "mixed"): string {
  const cfg = PRESET_CONFIGS[preset];

  const specialist_pool: Record<string, unknown> = {};
  for (const spec of SPECIALISTS) {
    specialist_pool[spec.name] = {
      summary: spec.summary,
      model: cfg.peer.model,
      api_key: cfg.peer.api_key,
      system: spec.system,
    };
  }

  const config = {
    defaults: {
      temperature: 0.2,
      max_retries: 3,
      compaction_threshold: 10,
      max_rounds: 1,
      plateau_epsilon: 0.02,         // strategy-scoring: end-of-loop slack
      plateau_k: 2,                  // strategy-scoring: rounds-flat threshold
      // workspace: ".",             // default: project dir. set to override
      // max_tool_steps: 10,         // cap tool-use round-trips per agent turn
      // scorer_model: "claude-haiku-4-5",  // cheaper model for strategy scoring
    },
    agents: {
      main: {
        model: cfg.main.model,
        api_key: cfg.main.api_key,
        system: SYSTEM_PEER,
      },
      peer: {
        model: cfg.peer.model,
        api_key: cfg.peer.api_key,
        system: SYSTEM_PEER,
      },
    },
    // informational — specialists summoned on demand by main or peer with a
    // scoped `ask`. move an entry into `agents` to pin it as a permanent
    // panel member. the loader ignores this block.
    specialist_pool,
  };

  return to_json(config);
}
