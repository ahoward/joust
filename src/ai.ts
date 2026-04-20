import { generateText, generateObject, isLoopFinished } from "ai";
import type { ToolSet } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { z } from "zod";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { check_context_size } from "./context";
import type { AgentConfig } from "./types";

// --- no-timeout fetch ---
// Bun's default fetch has a ~300s timeout. LLM calls with tool use can take
// much longer. Pass a custom fetch that strips the timeout entirely.

const no_timeout_fetch: typeof globalThis.fetch = (input, init) => {
  return globalThis.fetch(input, { ...init, signal: init?.signal ?? undefined });
};

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
    const provider = createAnthropic({ apiKey: api_key, fetch: no_timeout_fetch });
    return provider(model_id.replace("anthropic/", ""));
  }

  if (model_id.startsWith("gemini-") || model_id.startsWith("google/")) {
    const provider = createGoogleGenerativeAI({ apiKey: api_key, fetch: no_timeout_fetch });
    return provider(model_id.replace("google/", ""));
  }

  if (model_id.startsWith("gpt-") || model_id.startsWith("o1") || model_id.startsWith("openai/")) {
    const provider = createOpenAI({ apiKey: api_key, fetch: no_timeout_fetch });
    return provider(model_id.replace("openai/", ""));
  }

  // fallback: try anthropic
  const provider = createAnthropic({ apiKey: api_key, fetch: no_timeout_fetch });
  return provider(model_id);
}

// --- progress timer for long API calls ---

const DIM = process.stderr.isTTY ? "\x1b[2m" : "";
const RESET = process.stderr.isTTY ? "\x1b[0m" : "";
const CLEAR_LINE = process.stderr.isTTY ? "\x1b[2K\r" : "\r";

function start_progress_timer(label: string): () => void {
  const start = Date.now();
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stderr.write(`${CLEAR_LINE}${DIM}${label} ${elapsed}s${RESET}`);
  }, 5000);
  return () => {
    clearInterval(timer);
    process.stderr.write(CLEAR_LINE);
  };
}

// --- overload-aware retry ---
// Anthropic 529 "Overloaded" can persist for minutes. The SDK's built-in
// retry gives up after ~55s which is far too aggressive. Wrap calls in a
// longer backoff loop: 10s, 20s, 40s, 60s, 60s... capped at ~10 min total.
// We set the SDK's inner maxRetries to 0 so we own retry policy entirely.

const MAX_RETRY_ELAPSED_MS = 10 * 60 * 1000;
const BACKOFF_SCHEDULE_MS = [10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000];

function is_transient_error(err: any): boolean {
  const status = err?.statusCode ?? err?.status ?? err?.cause?.statusCode;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 529) return true;
  const msg = String(err?.message ?? err?.cause?.message ?? err ?? "").toLowerCase();
  if (msg.includes("overloaded")) return true;
  if (msg.includes("rate limit") || msg.includes("rate_limit")) return true;
  if (msg.includes("service unavailable")) return true;
  if (msg.includes("bad gateway")) return true;
  if (msg.includes("internal server error")) return true;
  return false;
}

function sleep_abortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", on_abort);
      resolve();
    }, ms);
    const on_abort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", on_abort, { once: true });
  });
}

async function with_retry<T>(
  label: string,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      if (signal?.aborted) throw err;
      if (!is_transient_error(err)) throw err;
      const elapsed = Date.now() - start;
      if (elapsed >= MAX_RETRY_ELAPSED_MS) throw err;
      const base = BACKOFF_SCHEDULE_MS[Math.min(attempt, BACKOFF_SCHEDULE_MS.length - 1)];
      const jitter = Math.floor(Math.random() * Math.min(5000, base / 2));
      const delay = base + jitter;
      attempt++;
      const msg = String(err?.message ?? err?.cause?.message ?? err);
      const short = msg.length > 80 ? msg.slice(0, 77) + "..." : msg;
      process.stderr.write(
        `${CLEAR_LINE}${DIM}${label} ${short} — retrying in ${Math.round(delay / 1000)}s (attempt ${attempt})${RESET}\n`
      );
      await sleep_abortable(delay, signal);
    }
  }
}

// --- per-agent log sink ---
//
// when a log_dir is provided, every API call writes a full pass-through
// record of the agent's turn to <dir>/agent-<name>.log: the input messages,
// every tool call + result, any assistant text, and the final structured
// output. this is the raw stream from the LLM — nothing is redacted.

function agent_log_path(log_dir: string, agent_name: string): string {
  try { mkdirSync(log_dir, { recursive: true }); } catch {}
  return join(log_dir, `agent-${agent_name}.log`);
}

function append_agent_log(log_dir: string | undefined, agent_name: string, text: string): void {
  if (!log_dir) return;
  try { appendFileSync(agent_log_path(log_dir, agent_name), text); } catch {}
}

function fmt_section(title: string): string {
  const ts = new Date().toISOString();
  return `\n===== ${ts}  ${title} =====\n`;
}

function fmt_messages(messages: Message[]): string {
  return messages.map((m) => `--- ${m.role} ---\n${m.content}\n`).join("\n");
}

function fmt_steps(steps: any[] | undefined): string {
  if (!steps || steps.length === 0) return "(no tool-use steps)\n";
  const parts: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    parts.push(`--- step ${i} ---`);
    if (s.text) parts.push(`text:\n${s.text}`);
    for (const call of s.toolCalls ?? []) {
      parts.push(`tool_call[${call.toolName}]: ${JSON.stringify(call.input ?? call.args, null, 2)}`);
    }
    for (const res of s.toolResults ?? []) {
      const out = typeof res.output === "string" ? res.output : JSON.stringify(res.output, null, 2);
      parts.push(`tool_result[${res.toolName}]:\n${out}`);
    }
  }
  return parts.join("\n") + "\n";
}

// --- message types ---

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CallOptions {
  signal?: AbortSignal;
  tools?: ToolSet;
  max_tool_steps?: number;
  log_dir?: string;       // per-agent log directory (usually <state-dir>/logs)
  log_label?: string;     // section label (e.g. "step 3 attempt 1" or "bootstrap")
}

// --- text generation ---

export async function call_agent(
  agent: AgentConfig,
  messages: Message[],
  options?: CallOptions
): Promise<string> {
  const model = get_model(agent);
  check_context_size(agent.model, messages);

  const system_msgs = messages.filter((m) => m.role === "system");
  const non_system = messages.filter((m) => m.role !== "system");
  const label = options?.log_label ?? "call";

  append_agent_log(
    options?.log_dir,
    agent.name,
    fmt_section(`${label} — call_agent (model=${agent.model})`) +
      fmt_messages(messages)
  );

  const stop_progress = start_progress_timer(`[${agent.name}]`);
  try {
    const result = await with_retry(`[${agent.name}]`, options?.signal, () =>
      generateText({
        model,
        system: system_msgs.map((m) => m.content).join("\n\n"),
        messages: non_system.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        temperature: agent.temperature ?? 0.2,
        abortSignal: options?.signal,
        maxRetries: 0,
        ...(options?.tools && {
          tools: options.tools,
          stopWhen: [isLoopFinished()],
        }),
      })
    );

    append_agent_log(
      options?.log_dir,
      agent.name,
      fmt_section(`${label} — response`) +
        fmt_steps((result as any).steps) +
        `--- final text ---\n${result.text}\n`
    );

    return result.text;
  } catch (err) {
    append_agent_log(
      options?.log_dir,
      agent.name,
      fmt_section(`${label} — ERROR`) + String((err as any)?.stack ?? err) + "\n"
    );
    throw err;
  } finally {
    stop_progress();
  }
}

// --- structured output ---
//
// two-phase approach when tools are involved:
//   phase 1: generateText with tools — agent reads files, builds analysis as free text
//   phase 2: generateObject — parse the analysis into structured output
//
// without tools: single-phase generateObject (reliable, native JSON mode)

export async function call_agent_structured<T>(
  agent: AgentConfig,
  messages: Message[],
  schema: z.ZodType<T>,
  options?: CallOptions
): Promise<T> {
  const model = get_model(agent);
  check_context_size(agent.model, messages);

  const system_msgs = messages.filter((m) => m.role === "system");
  const non_system = messages.filter((m) => m.role !== "system");
  const system = system_msgs.map((m) => m.content).join("\n\n");
  const formatted = non_system.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  const label = options?.log_label ?? "call";
  const log_dir = options?.log_dir;

  append_agent_log(
    log_dir,
    agent.name,
    fmt_section(`${label} — call_agent_structured (model=${agent.model}, tools=${!!options?.tools})`) +
      fmt_messages(messages)
  );

  const stop_progress = start_progress_timer(`[${agent.name}]`);
  try {
    if (options?.tools) {
      // phase 1: tool use — let the agent read files and think freely
      const research = await with_retry(`[${agent.name}]`, options?.signal, () =>
        generateText({
          model,
          system,
          messages: formatted,
          temperature: agent.temperature ?? 0.2,
          abortSignal: options?.signal,
          maxRetries: 0,
          tools: options!.tools,
          stopWhen: [isLoopFinished()],
        })
      );

      append_agent_log(
        log_dir,
        agent.name,
        fmt_section(`${label} — phase 1 (tool use)`) +
          fmt_steps((research as any).steps) +
          `--- phase 1 text ---\n${research.text}\n`
      );

      // build phase 2 messages — include research text if non-empty
      const phase2_messages = [...formatted];
      const research_text = research.text.trim();
      if (research_text) {
        phase2_messages.push({ role: "assistant" as const, content: research_text });
        phase2_messages.push({
          role: "user" as const,
          content: "Now produce your final output as structured JSON matching the required schema. Incorporate all findings from your analysis above.",
        });
      } else {
        // model used tools but produced no text summary — ask it to synthesize
        const tool_summary = research.steps
          .flatMap((s: any) => s.toolResults ?? [])
          .map((r: any) => `[${r.toolName}] ${String(r.output).slice(0, 500)}`)
          .join("\n\n");
        phase2_messages.push({
          role: "user" as const,
          content: [
            "The agent used tools to research the codebase. Here are the tool results:",
            "",
            tool_summary.slice(0, 50000),
            "",
            "Now produce your final output as structured JSON matching the required schema.",
          ].join("\n"),
        });
      }

      // phase 2: structured extraction — demand JSON
      const result = await with_retry(`[${agent.name}]`, options?.signal, () =>
        generateObject({
          model,
          schema,
          system,
          messages: phase2_messages,
          temperature: agent.temperature ?? 0.2,
          abortSignal: options?.signal,
          maxRetries: 0,
        })
      );

      append_agent_log(
        log_dir,
        agent.name,
        fmt_section(`${label} — phase 2 (structured output)`) +
          JSON.stringify(result.object, null, 2) + "\n"
      );

      return result.object;
    }

    // no tools: single-phase generateObject (reliable native JSON mode)
    const result = await with_retry(`[${agent.name}]`, options?.signal, () =>
      generateObject({
        model,
        schema,
        system,
        messages: formatted,
        temperature: agent.temperature ?? 0.2,
        abortSignal: options?.signal,
        maxRetries: 0,
      })
    );

    append_agent_log(
      log_dir,
      agent.name,
      fmt_section(`${label} — structured output`) +
        JSON.stringify(result.object, null, 2) + "\n"
    );

    return result.object;
  } catch (err) {
    append_agent_log(
      log_dir,
      agent.name,
      fmt_section(`${label} — ERROR`) + String((err as any)?.stack ?? err) + "\n"
    );
    throw err;
  } finally {
    stop_progress();
  }
}
