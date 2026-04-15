import { generateText, generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { z } from "zod";
import { check_context_size } from "./context";
import type { AgentConfig } from "./types";

// --- provider detection ---

function resolve_api_key(agent: AgentConfig): string {
  // api_key is a raw $ENV_VAR reference — resolve lazily, never persist
  const env_name = agent.api_key.replace(/^\$/, "");
  const key = process.env[env_name];
  if (!key) {
    throw new Error(`missing env var: ${agent.api_key} (required by agent '${agent.name}')`);
  }
  return key;
}

function get_model(agent: AgentConfig) {
  const model_id = agent.model;
  const api_key = resolve_api_key(agent);

  if (model_id.startsWith("claude-") || model_id.startsWith("anthropic/")) {
    const provider = createAnthropic({ apiKey: api_key });
    return provider(model_id.replace("anthropic/", ""));
  }

  if (model_id.startsWith("gemini-") || model_id.startsWith("google/")) {
    const provider = createGoogleGenerativeAI({ apiKey: api_key });
    return provider(model_id.replace("google/", ""));
  }

  if (model_id.startsWith("gpt-") || model_id.startsWith("o1") || model_id.startsWith("openai/")) {
    const provider = createOpenAI({ apiKey: api_key });
    return provider(model_id.replace("openai/", ""));
  }

  // fallback: try anthropic
  const provider = createAnthropic({ apiKey: api_key });
  return provider(model_id);
}

// --- progress timer for long API calls ---

function start_progress_timer(label: string): () => void {
  const start = Date.now();
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stderr.write(`\r${label} (${elapsed}s)`);
  }, 5000);
  return () => {
    clearInterval(timer);
    process.stderr.write("\r"); // clear the progress line
  };
}

// --- message types ---

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

// --- text generation ---

export async function call_agent(
  agent: AgentConfig,
  messages: Message[],
  options?: { signal?: AbortSignal }
): Promise<string> {
  const model = get_model(agent);
  check_context_size(agent.model, messages);

  const system_msgs = messages.filter((m) => m.role === "system");
  const non_system = messages.filter((m) => m.role !== "system");

  const stop_progress = start_progress_timer(`[${agent.name}]`);
  try {
    const result = await generateText({
      model,
      system: system_msgs.map((m) => m.content).join("\n\n"),
      messages: non_system.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      temperature: agent.temperature ?? 0.2,
      abortSignal: options?.signal,
      maxRetries: 0,
    });

    return result.text;
  } finally {
    stop_progress();
  }
}

// --- structured output ---

export async function call_agent_structured<T>(
  agent: AgentConfig,
  messages: Message[],
  schema: z.ZodType<T>,
  options?: { signal?: AbortSignal }
): Promise<T> {
  const model = get_model(agent);
  check_context_size(agent.model, messages);

  const system_msgs = messages.filter((m) => m.role === "system");
  const non_system = messages.filter((m) => m.role !== "system");

  const stop_progress = start_progress_timer(`[${agent.name}]`);
  try {
    const result = await generateObject({
      model,
      schema,
      system: system_msgs.map((m) => m.content).join("\n\n"),
      messages: non_system.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      temperature: agent.temperature ?? 0.2,
      abortSignal: options?.signal,
      maxRetries: 0,
    });

    return result.object;
  } finally {
    stop_progress();
  }
}
