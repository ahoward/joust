import { ZodError } from "zod";
import { log_status } from "./utils";

// --- exponential backoff ---

export function backoff_ms(attempt: number): number {
  return Math.min(Math.pow(2, attempt) * 1000, 60_000); // cap at 60s
}

// --- error classification ---

export function is_rate_limit(err: any): boolean {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (status === 429) return true;
  const msg = String(err?.message ?? "").toLowerCase();
  return msg.includes("rate limit") || msg.includes("too many requests");
}

export function is_server_error(err: any): boolean {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  return status >= 500 && status < 600;
}

export function is_parse_error(err: any): boolean {
  if (err instanceof ZodError) return true;
  // Vercel AI SDK's NoObjectGeneratedError
  if (err?.name === "NoObjectGeneratedError" || err?.name === "AI_NoObjectGeneratedError") return true;
  return false;
}

export function is_transient(err: any): boolean {
  return is_rate_limit(err) || is_server_error(err) || is_parse_error(err);
}

// --- tank wrapper ---

export async function tank_execute<T>(
  agent_name: string,
  fn: () => Promise<T>,
  max_retries: number = 5
): Promise<T | null> {
  let attempts = 0;

  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempts++;

      if (is_rate_limit(err)) {
        const wait = backoff_ms(attempts);
        log_status(agent_name, `rate limited, backing off ${wait}ms (attempt ${attempts})`);
        await Bun.sleep(wait);
        continue;
      }

      if (is_server_error(err)) {
        if (attempts >= max_retries) {
          log_status(agent_name, `server error after ${attempts} attempts, skipping`);
          return null;
        }
        const wait = backoff_ms(attempts);
        log_status(agent_name, `server error, retrying in ${wait}ms (attempt ${attempts})`);
        await Bun.sleep(wait);
        continue;
      }

      if (is_parse_error(err)) {
        if (attempts >= 2) {
          log_status(agent_name, `parse error after ${attempts} attempts, skipping`);
          return null;
        }
        log_status(agent_name, `parse error, retrying (attempt ${attempts})`);
        continue;
      }

      // not transient — rethrow
      throw err;
    }
  }
}

// --- timebox ---

export function parse_duration(s: string): number {
  const m = s.match(/^(\d+)(s|m|h)$/);
  if (!m) throw new Error(`invalid duration: ${s} (use e.g., 45m, 1h, 300s)`);
  const val = parseInt(m[1], 10);
  switch (m[2]) {
    case "s": return val * 1000;
    case "m": return val * 60 * 1000;
    case "h": return val * 60 * 60 * 1000;
    default: throw new Error(`invalid duration unit: ${m[2]}`);
  }
}

export function is_timeboxed_out(start_time: number, timebox_ms: number): boolean {
  return Date.now() - start_time > timebox_ms;
}
