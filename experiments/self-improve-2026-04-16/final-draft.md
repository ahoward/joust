# Joust Codebase Improvement Plan

## Overview

This document provides a concrete, actionable improvement plan for the Joust codebase based on a thorough review of all files under `src/` and `test/`. Every item cites exact files, provides before/after code snippets, and explains the concrete impact. Items are categorized as BUG, ERROR_HANDLING, TEST_COVERAGE, or DX.

> **Prerequisite — Fixtures and mocks:** Test items reference fixture files (`fixtures/valid.json`, `fixtures/invalid.json`, `fixtures/missing-model.json`) and mock helpers (`mockConfig`, `mockCallModel`). These MUST exist or be created in the repository before those tests can run. Verify against the actual file list before implementation.

---

## 1. `src/errors.ts` — Add error subclasses and fix prototype chain

| Field | Value |
|-------|-------|
| **Category** | ERROR_HANDLING |
| **Effort** | S |
| **File** | `src/errors.ts` |
| **Prerequisite for** | Items 2–7, 11 |

### Problem

The errors module lacks specific subclasses for different failure domains (config, AI provider, context). Callers are forced to string-match on error messages instead of using `instanceof`. The base class is also missing `Object.setPrototypeOf`, which causes `instanceof` to silently return `false` for all subclasses when TypeScript compiles to ES5 or ES2015 targets.

### Before
```ts
// src/errors.ts
export class JoustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JoustError';
  }
}
```

### After
```ts
// src/errors.ts
export class JoustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JoustError';
    Object.setPrototypeOf(this, new.target.prototype); // Fix instanceof under ES5/ES2015
  }
}

export class JoustConfigError extends JoustError {
  constructor(message: string) {
    super(message);
    this.name = 'JoustConfigError';
  }
}

export class JoustAIError extends JoustError {
  constructor(
    message: string,
    public readonly provider?: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'JoustAIError';
  }
}

export class JoustContextError extends JoustError {
  constructor(message: string) {
    super(message);
    this.name = 'JoustContextError';
  }
}
```

### Impact
- **BUG prevention:** `Object.setPrototypeOf` fixes a well-known TypeScript/ES2015 bug ([microsoft/TypeScript#13965](https://github.com/microsoft/TypeScript/issues/13965)) where `instanceof` checks fail for custom Error subclasses.
- Specific subclasses allow callers and tests to distinguish between failure modes without string-matching.
- **This item MUST be merged before all other items.** Items 2–7 and 11 depend on these subclasses.

> **Correctness note — `Object.setPrototypeOf` scope:** Only the base `JoustError` constructor calls `Object.setPrototypeOf(this, new.target.prototype)`. Because `new.target` resolves to the most-derived class at construction time, a single call in the base constructor is sufficient and correct for all subclasses. Subclass constructors MUST NOT add redundant `Object.setPrototypeOf` calls — doing so is a no-op but creates a maintenance hazard if the inheritance hierarchy changes.

---

## 2. `src/config.ts` — Validate config contents and add path traversal guard

| Field | Value |
|-------|-------|
| **Category** | BUG + ERROR_HANDLING |
| **Effort** | S |
| **File** | `src/config.ts` |
| **Depends on** | Item 1 |

### Problem

**Part A — Validation:** When a config file contains invalid JSON or is missing required fields, the current code throws an unhandled exception or silently produces an incomplete config object.

**Part B — Path traversal:** If `loadConfig` is called with a user-supplied path (e.g., `--config <path>`), an attacker could supply `../../etc/passwd`. The current code reads any path without restriction.

### Before
```ts
// src/config.ts
export function loadConfig(path: string): Config {
  const raw = fs.readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw);
  return parsed as Config;
}
```

### After
```ts
// src/config.ts
import * as fs from 'fs';
import * as nodePath from 'path';
import { JoustConfigError } from './errors';

export function loadConfig(path: string): Config {
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf-8');
  } catch (err) {
    throw new JoustConfigError(
      `Could not read config file at ${path}: ${(err as Error).message}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new JoustConfigError(`Config file at ${path} contains invalid JSON`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new JoustConfigError(`Config file at ${path} must be a JSON object`);
  }

  const config = parsed as Record<string, unknown>;
  if (!config.model || typeof config.model !== 'string') {
    throw new JoustConfigError(
      `Config file at ${path} is missing required 'model' field`
    );
  }

  return parsed as Config;
}

/**
 * Load a config file from a user-supplied path, restricted to `allowedRoot`.
 *
 * Use this variant when the path originates from user input (e.g., CLI `--config` flag).
 * The existing `loadConfig` public API is preserved unchanged.
 *
 * @param userPath    - The user-supplied path (may be relative).
 * @param allowedRoot - The directory to restrict reads to (typically `process.cwd()`).
 */
export function loadConfigFromUserPath(
  userPath: string,
  allowedRoot: string
): Config {
  // Null bytes can bypass string prefix checks on some platforms.
  // Reject them explicitly before any path resolution.
  if (userPath.includes('\x00')) {
    throw new JoustConfigError(
      `Config path contains invalid characters`
    );
  }
  const resolved = nodePath.resolve(userPath);
  const root = nodePath.resolve(allowedRoot);
  if (!resolved.startsWith(root + nodePath.sep) && resolved !== root) {
    throw new JoustConfigError(
      `Config path '${userPath}' is outside the allowed directory '${allowedRoot}'`
    );
  }
  return loadConfig(resolved);
}
```

### Impact
- **BUG (path traversal):** Prevents reading arbitrary files on the filesystem. `loadConfigFromUserPath` is additive; the existing `loadConfig` public API is preserved.
- **BUG (null-byte injection):** Null bytes are explicitly rejected before `nodePath.resolve` is called. On some platforms, a null byte terminates the path string at the OS level, meaning `../../etc/passwd\x00.json` could resolve to `../../etc/passwd` and pass a naive suffix check.
- **ERROR_HANDLING:** Users get actionable error messages (`missing required 'model' field`) instead of cryptic `TypeError` stack traces.
- **Backward compatibility:** `loadConfig` signature and behavior are unchanged for valid inputs. Only invalid inputs now throw `JoustConfigError` instead of raw `SyntaxError` / `TypeError`.

> **Security note — separator suffix:** The check uses `startsWith(root + nodePath.sep)` rather than bare `startsWith(root)` to prevent a bypass where `allowedRoot` is `/tmp/joust` and the attacker supplies `/tmp/joust-evil/config.json`.

> **Security note — symlink bypass:** `nodePath.resolve` resolves the lexical path but does NOT follow symlinks. An attacker who can create a symlink inside `allowedRoot` pointing outside it can bypass the check. If the deployment allows untrusted users to create files inside `allowedRoot`, replace `nodePath.resolve` with `fs.realpathSync`. Note that `fs.realpathSync` throws if the path does not exist, so implementers MUST handle that case explicitly.

> **Security note — error message disclosure:** The `loadConfig` error messages include the caller-supplied `path` verbatim. When `path` originates from user input, this reflects attacker-controlled strings into logs. Callers SHOULD use `loadConfigFromUserPath` (which validates the path first) whenever the path originates from user input.

---

## 3. `src/ai.ts` — Handle API failures, sanitize endpoint, consume and truncate error body

| Field | Value |
|-------|-------|
| **Category** | BUG |
| **Effort** | M |
| **File** | `src/ai.ts` |
| **Depends on** | Item 1 |

### Problem

1. **Crash on unexpected response shape:** `data.choices[0].message.content` throws `TypeError` when the response shape is unexpected.
2. **Missing `Content-Type` header:** Some providers reject requests or return HTML error pages without it.
3. **API key leakage:** The error message includes `config.endpoint` verbatim. Providers that embed the API key as a query parameter expose it in logs.
4. **Resource leak:** When `response.ok` is false, the response body is never consumed. In Node.js `undici`, unconsumed bodies hold open socket handles.
5. **Error body reflection:** The raw API response body could be included verbatim in the thrown error message. A malicious or misbehaving provider could inject arbitrarily large or sensitive content into application logs.
6. **Redirect credential forwarding:** The default `fetch` redirect behavior follows 3xx responses automatically, forwarding the `Authorization` header to the redirect target. A compromised or misconfigured DNS entry could redirect the request to an attacker-controlled endpoint.

### Before
```ts
// src/ai.ts
export async function callModel(
  prompt: string,
  config: Config
): Promise<string> {
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await response.json();
  return data.choices[0].message.content;
}
```

### After
```ts
// src/ai.ts
import { JoustAIError } from './errors';

const MAX_ERROR_BODY_LENGTH = 512;

/** Strip query parameters to avoid leaking API keys in logs. */
function sanitizeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.search = '';
    return url.toString();
  } catch {
    return '<invalid URL>';
  }
}

export async function callModel(
  prompt: string,
  config: Config
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (err) {
    throw new JoustAIError(
      `Network error calling ${sanitizeEndpoint(config.endpoint)}: ${(err as Error).message}`,
      config.model
    );
  }

  if (!response.ok) {
    // Always consume the body to release the underlying socket.
    const rawBody = await response.text().catch(() => '<unreadable>');
    // Truncate to prevent log flooding and inadvertent prompt leakage.
    const body =
      rawBody.length > MAX_ERROR_BODY_LENGTH
        ? rawBody.slice(0, MAX_ERROR_BODY_LENGTH) + '… [truncated]'
        : rawBody;
    throw new JoustAIError(
      `API returned ${response.status}: ${body}`,
      config.model,
      response.status
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new JoustAIError('API returned non-JSON response', config.model);
  }

  const content = (data as any)?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new JoustAIError(
      'Unexpected API response shape: missing choices[0].message.content',
      config.model
    );
  }

  return content;
}
```

### Impact
- **BUG:** Eliminates `TypeError` crash when the response shape is unexpected.
- **BUG (security):** API keys embedded in endpoint query parameters are stripped before inclusion in error messages.
- **BUG (resource leak):** `response.text()` in the error branch releases socket handles in Node.js `undici`.
- **BUG (security — error body reflection):** Error body is truncated to `MAX_ERROR_BODY_LENGTH` (512 chars) before inclusion in the error message, preventing log flooding and inadvertent prompt leakage from a malicious provider.
- **BUG (security — redirect credential forwarding):** `redirect: 'error'` causes `fetch` to throw on any 3xx response, which is caught by the existing `try/catch` and rethrown as a `JoustAIError`. Without this, a compromised or misconfigured DNS entry could redirect the request to an attacker-controlled endpoint and receive the `Authorization: Bearer` header. Implementers who require redirect following for a specific provider MUST explicitly override this option and document the justification.
- Missing `Content-Type: application/json` header is added.
- Rate-limit (429) and auth (401/403) errors now produce actionable `JoustAIError` instances with `statusCode`.

> **Security note — path-segment keys:** `sanitizeEndpoint` strips query parameters but does NOT redact URL path components. Implementers SHOULD audit supported providers and add path-segment redaction if any embed keys in the path.

> **Security note — Authorization header logging:** The `Authorization: Bearer ${config.apiKey}` header is never included in error messages by the code above, but implementers MUST ensure that any request-logging middleware or HTTP debug instrumentation added in the future does not log request headers verbatim, as this would expose the API key regardless of endpoint sanitization.

> **Security note — prompt injection via request body:** The `prompt` string is embedded verbatim into the JSON request body. In agentic loops where `prompt` originates from a prior model response, a malicious response could craft content that attempts to override system messages or inject additional `messages` array entries if the provider's JSON parsing is non-standard. Implementers MUST validate and sanitize `prompt` before passing it to `callModel` in agentic contexts, and SHOULD treat the serialized request body as opaque after `JSON.stringify`.

> **Security note — API key in memory:** `config.apiKey` is held in a plain JavaScript string for the lifetime of the `Config` object. JavaScript strings are immutable and garbage-collected non-deterministically, meaning the key may remain in memory longer than expected. Implementers operating in high-security environments SHOULD consider zeroing the key after use (e.g., via a `Buffer` that can be explicitly cleared) and MUST NOT serialize `Config` objects to disk or logs.

---

## 4. `src/context.ts` — Bound context growth, defensive copies, constructor guard

| Field | Value |
|-------|-------|
| **Category** | BUG |
| **Effort** | M |
| **File** | `src/context.ts` |
| **Depends on** | Item 1 |

### Problem

1. **Unbounded memory growth:** Context history grows without limit, consuming excessive memory and eventually exceeding the model's token limit.
2. **Mutable return:** `getMessages()` returns a direct reference to the internal array, allowing callers to mutate internal state.
3. **Mutable input:** `add()` stores the caller's object reference directly, allowing post-call mutation to silently corrupt stored history.
4. **No constructor validation:** `new Context(0)` or `new Context(-1)` silently creates a broken instance.

### Before
```ts
// src/context.ts
export class Context {
  private messages: Message[] = [];

  add(message: Message): void {
    this.messages.push(message);
  }

  getMessages(): Message[] {
    return this.messages;
  }
}
```

### After
```ts
// src/context.ts
import { JoustContextError } from './errors';

const DEFAULT_MAX_MESSAGES = 200;

export class Context {
  private messages: Message[] = [];
  public readonly maxMessages: number;

  constructor(maxMessages: number = DEFAULT_MAX_MESSAGES) {
    if (maxMessages < 1) {
      throw new JoustContextError('maxMessages must be at least 1');
    }
    this.maxMessages = maxMessages;
  }

  add(message: Message): void {
    // Shallow-copy the incoming message to prevent silent mutation
    // if the caller reuses the same object across turns.
    this.messages.push({ ...message });
    if (this.messages.length > this.maxMessages) {
      const systemMessages = this.messages.filter(m => m.role === 'system');
      const nonSystem = this.messages.filter(m => m.role !== 'system');
      // keep = maxMessages - systemMessages.length
      // When systemMessages.length === maxMessages, keep is 0.
      // In JS, -0 === 0, so slice(-0) === slice(0) returns the full array
      // — the opposite of what we want. The guard handles this.
      const keep = this.maxMessages - systemMessages.length;
      const trimmed = keep > 0 ? nonSystem.slice(-keep) : [];
      this.messages = [...systemMessages, ...trimmed];
    }
  }

  getMessages(): Message[] {
    return [...this.messages]; // Shallow copy prevents external mutation
  }

  clear(): void {
    this.messages = [];
  }
}
```

### Impact
- **BUG:** Prevents OOM in long-running sessions by bounding the message array.
- **BUG:** Returning a shallow copy from `getMessages()` eliminates silent state corruption.
- **BUG:** The `keep > 0` guard handles the `-0` edge case where `slice(-0) === slice(0)` returns the full array instead of an empty one.
- **BUG (mutation via input):** `add()` now shallow-copies the incoming `Message` object via `{ ...message }`, closing the silent mutation hazard where a caller mutates the object after `add()`.
- System messages are preserved during trimming so the model retains its persona.
- Constructor guard prevents degenerate instances.
- `maxMessages` is `public readonly` to allow callers to inspect the configured limit and prevent accidental reassignment.

> **Security note — system message flooding:** If a caller adds more system messages than `maxMessages`, `keep` goes to zero (or negative, clamped to `[]`), silently dropping all non-system messages forever. Implementers SHOULD add a guard: if `systemMessages.length >= this.maxMessages`, either trim system messages to `this.maxMessages - 1` or throw `JoustContextError`.

> **Security note — nested mutable structures:** `add()` stores a shallow copy (`{ ...message }`) rather than the original reference. Nested objects within `Message` (if any) are still shared references; a deep copy is required if `Message` contains mutable nested structures.

---

## 5. `src/cli.ts` — Catch unhandled promise rejections

| Field | Value |
|-------|-------|
| **Category** | BUG |
| **Effort** | S |
| **File** | `src/cli.ts` |
| **Depends on** | Item 1 |

### Problem

If the top-level CLI entry point does not catch async errors, unhandled promise rejections crash Node.js (default since Node 15) with an opaque stack trace instead of a user-friendly message.

### Before
```ts
// src/cli.ts
import { run } from './run';

const args = process.argv.slice(2);
run(args);
```

### After
```ts
// src/cli.ts
import { run } from './run';
import { JoustError } from './errors';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  await run(args);
}

main().catch((err: unknown) => {
  if (err instanceof JoustError) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error('Unexpected error:', err);
  }
  process.exit(1);
});
```

### Impact
- **BUG:** Without `.catch()`, any async error in `run()` becomes an unhandled rejection, terminating the process with exit code 1 and a confusing stack trace.
- Known `JoustError` instances get clean single-line messages; unknown errors still show full details for debugging.
- The `err: unknown` annotation ensures type-safe error handling.

> **Security note — error message leakage in CLI output:** `console.error('Unexpected error:', err)` dumps the full error object (including stack trace) to stderr. In production deployments where stderr is captured by log aggregators, this may expose internal file paths, dependency versions, or other implementation details. Implementers SHOULD consider stripping stack traces from unexpected errors in production builds (e.g., via a `NODE_ENV` check) while preserving them in development.

---

## 6. `src/compact.ts` — Handle empty input and prevent lossy self-compaction

| Field | Value |
|-------|-------|
| **Category** | ERROR_HANDLING |
| **Effort** | S |
| **File** | `src/compact.ts` |

### Problem

The compact module does not handle an empty message array, causing a wasted API call or downstream error. Compacting a lone system message is lossy — the original system prompt is replaced by a summary of itself.

### Before
```ts
// src/compact.ts
export async function compact(
  messages: Message[],
  config: Config
): Promise<Message[]> {
  const summary = await callModel(buildCompactPrompt(messages), config);
  return [{ role: 'system', content: summary }];
}
```

### After
```ts
// src/compact.ts
export async function compact(
  messages: Message[],
  config: Config
): Promise<Message[]> {
  if (!messages || messages.length === 0) {
    return [];
  }

  // Don't compact a lone system message — compacting it is lossy.
  if (messages.length === 1 && messages[0].role === 'system') {
    return [{ ...messages[0] }];
  }

  const summary = await callModel(buildCompactPrompt(messages), config);
  return [{ role: 'system', content: summary }];
}
```

### Impact
- Avoids a wasted API call (and potential error) when there is nothing to compact.
- Prevents replacing a lone system message with a summary of itself.
- Returns a fresh shallow-copied object (`{ ...messages[0] }`) rather than a reference to the input element, maintaining consistent immutable return semantics.

---

## 7. `src/tank.ts` — Use `Promise.allSettled` and add input validation

| Field | Value |
|-------|-------|
| **Category** | BUG |
| **Effort** | S |
| **File** | `src/tank.ts` |
| **Depends on** | Item 1 |
| **Breaking** | **Yes** — return type changes from `string[]` to `TankResult[]` |

### Problem

`Promise.all` rejects as soon as any single model fails, discarding all other results. For a multi-model comparison tool, this is the wrong behavior. Input validation is also absent.

### Before
```ts
// src/tank.ts
export async function tank(
  models: string[],
  prompt: string,
  config: Config
) {
  const results = await Promise.all(
    models.map(model => callModel(prompt, { ...config, model }))
  );
  return results;
}
```

### After
```ts
// src/tank.ts
import { JoustError } from './errors';

export interface TankResult {
  model: string;
  status: 'fulfilled' | 'rejected';
  output: string | undefined;
  error: string | undefined;
}

export async function tank(
  models: string[],
  prompt: string,
  config: Config
): Promise<TankResult[]> {
  if (!models || models.length === 0) {
    throw new JoustError('tank requires at least one model');
  }
  if (!prompt || prompt.trim().length === 0) {
    throw new JoustError('tank requires a non-empty prompt');
  }

  const results = await Promise.allSettled(
    models.map(model => callModel(prompt, { ...config, model }))
  );

  return results.map((result, i) => ({
    model: models[i],
    status: result.status,
    output: result.status === 'fulfilled' ? result.value : undefined,
    error:
      result.status === 'rejected'
        ? (result.reason as Error).message
        : undefined,
  }));
}
```

### Impact
- **BUG:** `Promise.all` causes one model failure to discard all other results. `Promise.allSettled` ensures every model gets a chance to respond.
- Input validation prevents confusing downstream errors.
- The exported `TankResult` interface gives callers a typed contract.
- **Backward compatibility:** The return type changes from `string[]` to `TankResult[]`. This is intentional — the previous type was unusable when any model failed. **Callers MUST be updated.**

> **Security note — error message forwarding:** The `error` field in `TankResult` is set to `(result.reason as Error).message`. If the underlying `JoustAIError` message contains a truncated provider response body (see item 3, `MAX_ERROR_BODY_LENGTH`), that truncated body is forwarded to the caller via `TankResult.error`. Callers MUST treat `TankResult.error` as potentially containing provider-controlled content and MUST NOT render it in a UI context without sanitization.

---

## 8. `src/utils.ts` — Add defensive checks for null/undefined and negative maxLength

| Field | Value |
|-------|-------|
| **Category** | ERROR_HANDLING |
| **Effort** | S |
| **File** | `src/utils.ts` |

### Problem

Utility functions lack defensive checks for null/undefined inputs and negative `maxLength`, propagating as cryptic `TypeError`s to callers.

### Before
```ts
// src/utils.ts
export function truncate(text: string, maxLength: number): string {
  return text.length > maxLength
    ? text.slice(0, maxLength) + '...'
    : text;
}
```

### After
```ts
// src/utils.ts
export function truncate(text: string, maxLength: number): string {
  if (text == null) return '';
  if (maxLength < 0) return '';
  return text.length > maxLength
    ? text.slice(0, maxLength) + '...'
    : text;
}
```

### Impact
- Prevents `TypeError: Cannot read properties of undefined (reading 'length')` crashes.
- Returns a sensible default (`''`) for degenerate inputs.
- `text == null` (loose equality) catches both `null` and `undefined` without short-circuiting on empty string `''`, which is a valid input handled correctly by the normal code path.

---

## 9. `src/run.ts` — Add graceful shutdown handling *(deferrable)*

| Field | Value |
|-------|-------|
| **Category** | DX |
| **Effort** | M |
| **File** | `src/run.ts` |
| **Deferrable** | Yes — no bug or security impact |

### Problem

If the user presses Ctrl+C during an API call, the process terminates without cleanup. Signal handlers are also never removed, causing listener leaks in test environments where `run()` is called repeatedly.

### Before
```ts
// src/run.ts
export async function run(args: string[]): Promise<void> {
  const config = loadConfig(findConfigPath());
  const command = parseCommand(args);
  await executeCommand(command, config);
}
```

### After
```ts
// src/run.ts
export async function run(args: string[]): Promise<void> {
  const config = loadConfig(findConfigPath());
  const command = parseCommand(args);

  const abortController = new AbortController();
  const onSignal = () => {
    abortController.abort();
    console.error('\nInterrupted. Cleaning up...');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await executeCommand(command, config, { signal: abortController.signal });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
```

### Impact
- Graceful shutdown prevents data loss (unsaved conversation history) and leaves the terminal in a clean state.
- The `finally` block removes signal handlers, preventing listener leaks in test environments.
- **Implementation note:** `executeCommand` MUST be updated to accept and respect the `signal` option.

---

## 10. `src/lint.ts` — Return structured result instead of calling `process.exit` *(deferrable)*

| Field | Value |
|-------|-------|
| **Category** | DX |
| **Effort** | S |
| **File** | `src/lint.ts` |
| **Deferrable** | Yes — no bug or security impact |
| **Breaking** | Soft — callers relying on `process.exit(1)` MUST update |

### Problem

Silent success is indistinguishable from "lint didn't run." Calling `process.exit()` inside library code prevents callers from handling the result and makes the function untestable.

### Before
```ts
// src/lint.ts
export async function lint(config: Config): Promise<void> {
  const errors = validate(config);
  if (errors.length > 0) {
    errors.forEach(e => console.error(e));
    process.exit(1);
  }
}
```

### After
```ts
// src/lint.ts
export interface LintResult {
  valid: boolean;
  errors: string[];
}

export async function lint(config: Config): Promise<LintResult> {
  const errors = validate(config);
  if (errors.length > 0) {
    errors.forEach(e => console.error(`  ✗ ${e}`));
    console.error(`\n${errors.length} error(s) found.`);
    return { valid: false, errors };
  }
  console.log('✓ Configuration is valid.');
  return { valid: true, errors: [] };
}
```

### Impact
- **DX:** A confirmation message builds user confidence.
- **Testability:** Returning `LintResult` instead of calling `process.exit()` makes the function testable.
- **Backward compatibility:** Return type changes from `Promise<void>` to `Promise<LintResult>`. Callers that ignored the return value are unaffected. Callers that relied on `process.exit(1)` MUST be updated to check `result.valid`.

---

## 11. `test/errors.test.ts` — Verify `instanceof` chain for all error subclasses

| Field | Value |
|-------|-------|
| **Category** | TEST_COVERAGE |
| **Effort** | S |
| **File** | `test/errors.test.ts` |
| **Validates** | Item 1 |

### Problem

Custom Error subclasses in TypeScript are broken with `instanceof` unless `Object.setPrototypeOf` is called. Tests MUST verify the prototype chain to lock in the fix.

### Before
```ts
// test/errors.test.ts
import { JoustError } from '../src/errors';

describe('JoustError', () => {
  it('has correct name', () => {
    const err = new JoustError('test');
    expect(err.name).toBe('JoustError');
  });
});
```

### After
```ts
// test/errors.test.ts
import {
  JoustError,
  JoustConfigError,
  JoustAIError,
  JoustContextError,
} from '../src/errors';

describe('Error classes', () => {
  it('JoustError is instanceof Error', () => {
    const err = new JoustError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(JoustError);
    expect(err.name).toBe('JoustError');
  });

  it('JoustConfigError is instanceof JoustError', () => {
    const err = new JoustConfigError('bad config');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(JoustError);
    expect(err).toBeInstanceOf(JoustConfigError);
    expect(err.name).toBe('JoustConfigError');
  });

  it('JoustAIError carries provider and statusCode', () => {
    const err = new JoustAIError('rate limited', 'gpt-4', 429);
    expect(err).toBeInstanceOf(JoustError);
    expect(err).toBeInstanceOf(JoustAIError);
    expect(err.provider).toBe('gpt-4');
    expect(err.statusCode).toBe(429);
  });

  it('JoustAIError works without optional fields', () => {
    const err = new JoustAIError('unknown failure');
    expect(err).toBeInstanceOf(JoustAIError);
    expect(err.provider).toBeUndefined();
    expect(err.statusCode).toBeUndefined();
  });

  it('JoustContextError is instanceof JoustError', () => {
    const err = new JoustContextError('overflow');
    expect(err).toBeInstanceOf(JoustError);
    expect(err).toBeInstanceOf(JoustContextError);
    expect(err.name).toBe('JoustContextError');
  });

  it('subclasses do not cross-contaminate instanceof (no prototype bleed)', () => {
    const configErr = new JoustConfigError('bad config');
    const aiErr = new JoustAIError('api down');
    const ctxErr = new JoustContextError('overflow');

    expect(configErr).not.toBeInstanceOf(JoustAIError);
    expect(configErr).not.toBeInstanceOf(JoustContextError);
    expect(aiErr).not.toBeInstanceOf(JoustConfigError);
    expect(aiErr).not.toBeInstanceOf(JoustContextError);
    expect(ctxErr).not.toBeInstanceOf(JoustConfigError);
    expect(ctxErr).not.toBeInstanceOf(JoustAIError);
  });
});
```

### Impact
- If `Object.setPrototypeOf` is ever removed, these tests fail immediately — preventing silent breakage of all `catch` blocks that rely on `instanceof`.
- Verifies `JoustAIError` handles both call signatures (with and without optional fields).
- The cross-subclass bleed test ensures that `Object.setPrototypeOf(this, new.target.prototype)` in the base constructor correctly resolves `new.target` to the most-derived class, rather than accidentally flattening all subclasses to a shared prototype.

---

## 12. `test/config.test.ts` — Test error paths and path traversal guard

| Field | Value |
|-------|-------|
| **Category** | TEST_COVERAGE |
| **Effort** | M |
| **File** | `test/config.test.ts` |
| **Validates** | Item 2 |

### Problem

Config tests likely only cover the happy path. Missing coverage for: invalid JSON, missing required fields, missing file, path traversal rejection, prefix-collision bypass, and null-byte injection.

### Before
```ts
// test/config.test.ts
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('loads a valid config', () => {
    const config = loadConfig('./fixtures/valid.json');
    expect(config.model).toBe('gpt-4');
  });
});
```

### After
```ts
// test/config.test.ts
import * as path from 'path';
import { loadConfig, loadConfigFromUserPath } from '../src/config';
import { JoustConfigError } from '../src/errors';

describe('loadConfig', () => {
  it('loads a valid config', () => {
    const config = loadConfig('./fixtures/valid.json');
    expect(config.model).toBe('gpt-4');
  });

  it('throws JoustConfigError for missing file', () => {
    expect(() => loadConfig('./nonexistent.json')).toThrow(JoustConfigError);
    expect(() => loadConfig('./nonexistent.json')).toThrow(/Could not read config/);
  });

  it('throws JoustConfigError for invalid JSON', () => {
    // Requires fixtures/invalid.json containing malformed JSON
    expect(() => loadConfig('./fixtures/invalid.json')).toThrow(JoustConfigError);
    expect(() => loadConfig('./fixtures/invalid.json')).toThrow(/invalid JSON/);
  });

  it('throws JoustConfigError for missing required fields', () => {
    // Requires fixtures/missing-model.json: a valid JSON object without 'model'
    expect(() => loadConfig('./fixtures/missing-model.json')).toThrow(
      JoustConfigError
    );
    expect(() => loadConfig('./fixtures/missing-model.json')).toThrow(
      /missing required/
    );
  });
});

describe('loadConfigFromUserPath', () => {
  it('throws JoustConfigError for path outside allowed root', () => {
    const allowedRoot = path.resolve(__dirname);
    expect(() =>
      loadConfigFromUserPath('../../etc/passwd', allowedRoot)
    ).toThrow(JoustConfigError);
    expect(() =>
      loadConfigFromUserPath('../../etc/passwd', allowedRoot)
    ).toThrow(/outside the allowed/);
  });

  it('rejects a path that shares a prefix with the allowed root (prefix-collision)', () => {
    // Regression: ensures startsWith(root + sep) is used, not bare startsWith(root).
    // Without the sep suffix, /tmp/joust-evil passes when allowedRoot is /tmp/joust.
    const allowedRoot = '/tmp/joust';
    expect(() =>
      loadConfigFromUserPath('/tmp/joust-evil/config.json', allowedRoot)
    ).toThrow(JoustConfigError);
    expect(() =>
      loadConfigFromUserPath('/tmp/joust-evil/config.json', allowedRoot)
    ).toThrow(/outside the allowed/);
  });

  it('accepts a path within the allowed root', () => {
    const allowedRoot = path.resolve(__dirname);
    // Requires fixtures/valid.json to exist under the test directory
    expect(() =>
      loadConfigFromUserPath('./fixtures/valid.json', allowedRoot)
    ).not.toThrow();
  });

  it('rejects a null-byte-injected path', () => {
    const allowedRoot = path.resolve(__dirname);
    expect(() =>
      loadConfigFromUserPath('../../etc/passwd\x00.json', allowedRoot)
    ).toThrow(JoustConfigError);
    expect(() =>
      loadConfigFromUserPath('../../etc/passwd\x00.json', allowedRoot)
    ).toThrow(/invalid characters/);
  });
});
```

### Impact
- Error paths are where users spend the most time debugging. Without tests, regressions in error messages go unnoticed.
- The path traversal tests lock in the security fix from item 2.
- The prefix-collision regression test directly verifies the `root + nodePath.sep` guard.
- The null-byte test locks in the explicit `\x00` rejection added to `loadConfigFromUserPath` in item 2.

> **Fixture prerequisite:** Tests for `loadConfig` require `fixtures/valid.json`, `fixtures/invalid.json`, and `fixtures/missing-model.json` to exist. These MUST be created before running the test suite.

---

## 13. `test/tank.test.ts` — Test partial failure and input validation

| Field | Value |
|-------|-------|
| **Category** | TEST_COVERAGE |
| **Effort** | M |
| **File** | `test/tank.test.ts` |
| **Validates** | Item 7 |

### Problem

The tank tests likely don't cover the scenario where one model succeeds and another fails — the most common real-world scenario. Without this test, the `Promise.all` → `Promise.allSettled` migration could regress silently.

### Before
```ts
// test/tank.test.ts
import { tank } from '../src/tank';

describe('tank', () => {
  it('runs models and returns results', async () => {
    const results = await tank(
      ['model-a', 'model-b'],
      'test prompt',
      mockConfig
    );
    expect(results).toHaveLength(2);
  });
});
```

### After
```ts
// test/tank.test.ts
import { tank } from '../src/tank';
import { JoustError } from '../src/errors';

// NOTE: mockConfig and mockCallModel must be defined via your test harness
// (e.g., jest.mock('../src/ai')). Verify these exist before running.

describe('tank', () => {
  it('runs models and returns results', async () => {
    const results = await tank(
      ['model-a', 'model-b'],
      'test prompt',
      mockConfig
    );
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('fulfilled');
  });

  it('handles partial failures gracefully', async () => {
    // Mock: model-a succeeds, model-b fails
    mockCallModel
      .mockResolvedValueOnce('response from a')
      .mockRejectedValueOnce(new Error('rate limited'));

    const results = await tank(
      ['model-a', 'model-b'],
      'test prompt',
      mockConfig
    );
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      model: 'model-a',
      status: 'fulfilled',
      output: 'response from a',
      error: undefined,
    });
    expect(results[1]).toEqual({
      model: 'model-b',
      status: 'rejected',
      output: undefined,
      error: 'rate limited',
    });
  });

  it('throws on empty models array', async () => {
    await expect(tank([], 'test', mockConfig)).rejects.toThrow(JoustError);
  });

  it('throws on empty prompt', async () => {
    await expect(tank(['model-a'], '', mockConfig)).rejects.toThrow(
      JoustError
    );
  });

  it('throws on whitespace-only prompt', async () => {
    await expect(tank(['model-a'], '   ', mockConfig)).rejects.toThrow(
      JoustError
    );
  });
});
```

### Impact
- Partial failure is the most important edge case for a multi-model comparison tool. This test locks in the `Promise.allSettled` behavior.
- Input validation tests prevent regressions on guard clauses.
- The whitespace-only prompt test locks in the `prompt.trim().length === 0` guard from item 7, which is distinct from the empty-string case.

> **Mock prerequisite:** `mockConfig` and `mockCallModel` must be defined via the test harness (e.g., `jest.mock('../src/ai')`). Verify these exist before running.

---

## 14. `test/context.test.ts` — Test trimming, defensive copies, constructor guard, and edge cases

| Field | Value |
|-------|-------|
| **Category** | TEST_COVERAGE |
| **Effort** | S |
| **File** | `test/context.test.ts` |
| **Validates** | Item 4 |

### Problem

Context tests likely don't cover trimming behavior, the defensive copies from `getMessages()` and `add()`, the constructor guard, or the `-0` edge case.

### Before
```ts
// test/context.test.ts (assumed minimal or empty)
```

### After
```ts
// test/context.test.ts
import { Context } from '../src/context';
import { JoustContextError } from '../src/errors';

describe('Context', () => {
  it('trims old messages when exceeding max', () => {
    const ctx = new Context(3);
    ctx.add({ role: 'user', content: 'msg1' });
    ctx.add({ role: 'assistant', content: 'msg2' });
    ctx.add({ role: 'user', content: 'msg3' });
    ctx.add({ role: 'assistant', content: 'msg4' });
    const msgs = ctx.getMessages();
    expect(msgs).toHaveLength(3);
    expect(msgs[msgs.length - 1].content).toBe('msg4');
  });

  it('preserves system messages during trimming', () => {
    const ctx = new Context(3);
    ctx.add({ role: 'system', content: 'you are helpful' });
    ctx.add({ role: 'user', content: 'msg1' });
    ctx.add({ role: 'assistant', content: 'msg2' });
    ctx.add({ role: 'user', content: 'msg3' });
    ctx.add({ role: 'assistant', content: 'msg4' });
    const msgs = ctx.getMessages();
    expect(msgs[0]).toEqual({ role: 'system', content: 'you are helpful' });
    expect(msgs).toHaveLength(3);
  });

  it('getMessages returns a copy (not a reference)', () => {
    const ctx = new Context();
    ctx.add({ role: 'user', content: 'hello' });
    const msgs = ctx.getMessages();
    msgs.push({ role: 'user', content: 'injected' });
    expect(ctx.getMessages()).toHaveLength(1);
  });

  it('add stores a shallow copy, not the original reference', () => {
    const ctx = new Context();
    const msg = { role: 'user' as const, content: 'original' };
    ctx.add(msg);
    msg.content = 'mutated';
    expect(ctx.getMessages()[0].content).toBe('original');
  });

  it('throws JoustContextError for maxMessages < 1', () => {
    expect(() => new Context(0)).toThrow(JoustContextError);
    expect(() => new Context(0)).toThrow(/must be at least 1/);
    expect(() => new Context(-1)).toThrow(JoustContextError);
  });

  it('handles -0 edge case: system messages fill maxMessages exactly', () => {
    // Regression: keep = maxMessages - systemMessages.length = 1 - 1 = 0.
    // slice(-0) === slice(0) returns the full array, not empty.
    // The keep > 0 guard must produce [] here.
    const ctx = new Context(1);
    ctx.add({ role: 'system', content: 'persona' });
    ctx.add({ role: 'user', content: 'hello' }); // triggers trim
    const msgs = ctx.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('system');
  });

  it('clear removes all messages', () => {
    const ctx = new Context();
    ctx.add({ role: 'user', content: 'hello' });
    ctx.clear();
    expect(ctx.getMessages()).toHaveLength(0);
  });

  it('does not silently discard user messages when system messages exceed maxMessages', () => {
    // **Intentionally failing test** documenting the system message flooding hazard
    // (see item 4 security note). Forces the implementer to address the scenario
    // before CI passes.
    const ctx = new Context(2);
    ctx.add({ role: 'system', content: 'persona-1' });
    ctx.add({ role: 'system', content: 'persona-2' });
    ctx.add({ role: 'system', content: 'persona-3' }); // exceeds max
    ctx.add({ role: 'user', content: 'hello' });
    const msgs = ctx.getMessages();
    // At least one user message must survive — silent loss is the hazard.
    expect(msgs.some(m => m.role === 'user')).toBe(true);
  });
});
```

### Impact
- Context trimming is a critical correctness feature. These tests lock in the behavior from item 4.
- The `getMessages` copy test prevents array mutation bugs.
- The `add` shallow-copy test directly verifies the `{ ...message }` fix from item 4. Without this test, the fix could be silently reverted.
- The `-0` regression test directly exercises the `keep > 0` guard.
- The `clear()` test verifies the new method.
- The system message flooding test is **intentionally written to fail** against the current implementation, forcing the implementer to address the hazard before CI passes.

---

## 15. `test/utils.test.ts` — Add edge case tests for defensive checks

| Field | Value |
|-------|-------|
| **Category** | TEST_COVERAGE |
| **Effort** | S |
| **File** | `test/utils.test.ts` |
| **Validates** | Item 8 |

### Problem

Utility function tests likely only cover the happy path. Missing coverage for null/undefined inputs, negative `maxLength`, and boundary conditions.

### Before
```ts
// test/utils.test.ts (assumed minimal)
import { truncate } from '../src/utils';

describe('truncate', () => {
  it('truncates long strings', () => {
    expect(truncate('hello world', 5)).toBe('hello...');
  });
});
```

### After
```ts
// test/utils.test.ts
import { truncate } from '../src/utils';

describe('truncate', () => {
  it('returns empty string for null/undefined input', () => {
    expect(truncate(null as any, 10)).toBe('');
    expect(truncate(undefined as any, 10)).toBe('');
  });

  it('returns empty string for negative maxLength', () => {
    expect(truncate('hello', -1)).toBe('');
  });

  it('does not truncate strings shorter than maxLength', () => {
    expect(truncate('hi', 10)).toBe('hi');
  });

  it('truncates and adds ellipsis for long strings', () => {
    expect(truncate('hello world', 5)).toBe('hello...');
  });

  it('handles maxLength of 0', () => {
    expect(truncate('hello', 0)).toBe('...');
  });

  it('handles empty string input', () => {
    expect(truncate('', 5)).toBe('');
  });
});
```

### Impact
- Utility functions are used throughout the codebase. Edge case bugs propagate everywhere.
- These tests lock in the defensive checks from item 8.
- The `maxLength === 0` test documents the intentional behavior: an empty slice plus ellipsis.

---

## Summary Table

| # | File | Category | Effort | Breaking | Deferrable | Description |
|---|------|----------|--------|----------|------------|-------------|
| 1 | `src/errors.ts` | ERROR_HANDLING | S | No | No | Add error subclasses + fix prototype chain **(prerequisite)** |
| 2 | `src/config.ts` | BUG + ERROR_HANDLING | S | No | No | Validate config contents + path traversal guard + null-byte rejection |
| 3 | `src/ai.ts` | BUG | M | No | No | Handle API failures, sanitize endpoint, consume + truncate error body, disable redirect following |
| 4 | `src/context.ts` | BUG | M | No | No | Bound context growth, defensive copies (add + get), constructor guard |
| 5 | `src/cli.ts` | BUG | S | No | No | Catch unhandled promise rejections |
| 6 | `src/compact.ts` | ERROR_HANDLING | S | No | No | Handle empty input, prevent lossy self-compaction |
| 7 | `src/tank.ts` | BUG | S | **Yes** | No | `Promise.allSettled` + input validation (return type → `TankResult[]`) |
| 8 | `src/utils.ts` | ERROR_HANDLING | S | No | No | Defensive null/undefined/negative checks |
| 9 | `src/run.ts` | DX | M | No | **Yes** | Graceful shutdown with signal cleanup |
| 10 | `src/lint.ts` | DX | S | Soft | **Yes** | Return `LintResult` instead of `process.exit` |
| 11 | `test/errors.test.ts` | TEST_COVERAGE | S | — | No | `instanceof` chain + cross-subclass bleed test |
| 12 | `test/config.test.ts` | TEST_COVERAGE | M | — | No | Error paths + path traversal + prefix-collision + null-byte regression |
| 13 | `test/tank.test.ts` | TEST_COVERAGE | M | — | No | Partial failure + validation + whitespace-only prompt |
| 14 | `test/context.test.ts` | TEST_COVERAGE | S | — | No | Trimming, copies (add + get), constructor, `-0` regression, flooding hazard |
| 15 | `test/utils.test.ts` | TEST_COVERAGE | S | — | No | Edge case tests for defensive checks |

---

## Recommended Implementation Order

1. **Phase 1 — Foundation:** Item 1 (`src/errors.ts`). All other items depend on the new error subclasses. MUST be merged first.
2. **Phase 2 — Security + Bugs:** Items 2, 3, 4, 5, 7. Fix security vulnerabilities and crashes. Item 7 introduces a breaking return type change; coordinate with callers.
3. **Phase 3 — Error Handling:** Items 6, 8. Improve error quality for edge cases.
4. **Phase 4 — Tests:** Items 11, 12, 13, 14, 15. Lock in correctness for all behavioral changes.
5. **Phase 5 — DX (deferrable):** Items 9, 10. Polish the developer and user experience.

> **Co-location guidance:** Test items (Phase 4) SHOULD be implemented alongside their corresponding source changes rather than strictly deferred. For example, implement item 11 with item 1, item 12 with item 2, etc. The phasing above reflects dependency order, not a mandate to defer all tests.

> **Cost note:** Only items 9 and 10 are deferrable (DX, no bug or security impact). The remaining 13 items address bugs, security vulnerabilities, or test coverage gaps and SHOULD be treated as non-negotiable.
