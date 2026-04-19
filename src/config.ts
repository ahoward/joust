import { existsSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { load_config, redact, to_json } from "./utils";
import { JoustError } from "./errors";
import type { JoustConfig, AgentConfig, JoustDefaults } from "./types";

// --- built-in defaults ---

const DEFAULT_DEFAULTS: JoustDefaults = {
  temperature: 0.2,
  max_retries: 3,
  compaction_threshold: 10,
  max_rounds: 1,
};

const BUILTIN_AGENTS: Record<string, Omit<AgentConfig, "name">> = {
  main: {
    model: "claude-opus-4-6",
    api_key: "$ANTHROPIC_API_KEY",
    system:
      "You are the lead architect. You own the core vision. " +
      "Before any peer review, define strict RFC 2119 invariants (MUST, SHOULD, MUST NOT). " +
      "Protect these invariants across all revisions.",
  },
  security: {
    model: "claude-sonnet-4-6",
    api_key: "$ANTHROPIC_API_KEY",
    system:
      "You are a ruthless security auditor. " +
      "Mutate the draft to close vulnerabilities, " +
      "but you MUST respect the lead architect's invariants.",
  },
  cfo: {
    model: "claude-sonnet-4-6",
    api_key: "$ANTHROPIC_API_KEY",
    system:
      "You are the CFO. Critique the proposal strictly on cost, margin, and vendor lock-in. " +
      "Mutate the draft to optimize for cost, " +
      "but you MUST respect the lead architect's invariants.",
  },
};

// --- resolve config ---

function expand_agent_config(name: string, raw: Record<string, any>, defaults: JoustDefaults): AgentConfig {
  const raw_key = raw.api_key ?? "$ANTHROPIC_API_KEY";

  // api_key must be an env var reference — never a literal key
  if (!raw_key.startsWith("$")) {
    throw new JoustError(
      `agent '${name}' api_key must be an env var reference like $ANTHROPIC_API_KEY, got literal string. ` +
      `Never put raw API keys in config files. (config: ${to_json(redact(raw as Record<string, unknown>))})`
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

  // layer 2: user global config (~/.joust/config.yaml)
  const global_path = join(homedir(), ".joust", "config.yaml");
  if (existsSync(global_path)) {
    const global_cfg = load_config(global_path) as any;
    if (global_cfg?.defaults) {
      merged_defaults = { ...merged_defaults, ...global_cfg.defaults };
    }
    if (global_cfg?.agents) {
      merged_agents = { ...merged_agents, ...global_cfg.agents };
    }
  }

  // layer 3: project config (rfc.yaml)
  // if project defines agents, it REPLACES the built-in set (not merge).
  // the user is being explicit about their panel.
  if (project_dir) {
    const project_path = join(project_dir, "rfc.yaml");
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

// --- generate default rfc.yaml content ---

export function generate_default_config(): string {
  const lines = [
    "defaults:",
    "  temperature: 0.2",
    "  max_retries: 3",
    "  compaction_threshold: 10",
    "  max_rounds: 1",
    "  # workspace: .                   # default: project dir. set to override",
    "  # max_tool_steps: 10             # cap tool-use round-trips per agent turn",
    "",
    "agents:",
    "  main:",
    "    model: claude-opus-4-6",
    "    api_key: $ANTHROPIC_API_KEY",
    "    system: >",
    "      You are the lead architect. You own the core vision.",
    "      Before any peer review, define strict RFC 2119 invariants",
    "      (MUST, SHOULD, MUST NOT). Protect these invariants across all revisions.",
    "",
    "  security:",
    "    model: claude-sonnet-4-6",
    "    api_key: $ANTHROPIC_API_KEY",
    "    system: >",
    "      You are a ruthless security auditor. Mutate the draft to close",
    "      vulnerabilities, but you MUST respect the invariants.",
    "",
    "  cfo:",
    "    model: claude-sonnet-4-6",
    "    api_key: $ANTHROPIC_API_KEY",
    "    system: >",
    "      You are the CFO. Optimize for cost and margin,",
    "      but you MUST respect the invariants.",
    "",
  ];
  return lines.join("\n");
}
