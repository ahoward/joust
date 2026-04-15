import { generateText, generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { z } from "zod";
import type { AgentConfig } from "./types";

// --- provider detection ---

function get_model(agent: AgentConfig) {
  const model_id = agent.model;
  const api_key = agent.api_key;

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

  const system_msgs = messages.filter((m) => m.role === "system");
  const non_system = messages.filter((m) => m.role !== "system");

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
}

// --- structured output ---

export async function call_agent_structured<T>(
  agent: AgentConfig,
  messages: Message[],
  schema: z.ZodType<T>,
  options?: { signal?: AbortSignal }
): Promise<T> {
  const model = get_model(agent);

  const system_msgs = messages.filter((m) => m.role === "system");
  const non_system = messages.filter((m) => m.role !== "system");

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
}
