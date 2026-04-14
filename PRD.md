# PRD: joust

## Adversarial Architecture Compiler

### 1. What It Is

`joust` is a compiled CLI that pits LLM agents against each other in structured,
sequential debate to produce hardened technical artifacts. Instead of trusting one
LLM pass (confident, well-structured, wrong), joust runs a panel of
persona-driven agents through an invariant-enforced accumulator loop. The
filesystem is the database. STDOUT is the deliverable. Everything else is a turd
on disk.

### 2. Tech Stack

- **Runtime/compiler:** Bun (`bun build --compile` to standalone binary)
- **AI layer:** Vercel AI SDK (`ai` core + `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`)
- **Structured output:** Zod schemas via `generateObject`
- **Config format:** YAML (human-facing), pretty JSON (machine state)
- **Zero runtime deps** for end users -- single binary

### 3. Core Concepts

**The Panel** -- a set of agents, each defined by model + system prompt:
- `main`: lead architect. Seeds the draft, defines invariants, lints jouster
  output, polishes the final result.
- `jousters`: persona-driven specialists (Security Auditor, CFO, DBA, etc.)
  that sequentially mutate the draft.

**The Snowball** -- a JSON state object that rolls from agent to agent:
```json
{
  "invariants": {
    "MUST": ["..."],
    "SHOULD": ["..."],
    "MUST_NOT": ["..."]
  },
  "draft": "# Architecture v3\n...",
  "critique_trail": [
    { "actor": "security", "action": "mutated_draft", "notes": "..." }
  ],
  "resolved_decisions": [],
  "human_directives": []
}
```

**Invariants** -- RFC 2119 rules (`MUST`, `SHOULD`, `MUST NOT`) extracted by
`main` during bootstrap. Jousters are bound by them. Violations trigger retry.
`SHOULD` violations require explicit justification or they also trigger retry.

**Linting** -- after each jouster mutates the draft, `main` runs a structured
validation pass (`generateObject` with a Zod schema) that outputs
`{ valid: boolean, violations: string[] }`. This is the compiler's type checker.

**Compaction** -- every N rounds (default 10), `main` compresses the
`critique_trail` into a dense `resolved_decisions` block to bound context window
growth. The full history is always preserved on disk.

### 4. Filesystem Layout (The "Bomber" Architecture)

```
<project-slug>/
  rfc.yaml            # human-editable config (personas, keys, limits)
  snowball.json       # current working state (pretty JSON, atomic copy)
  history/            # append-only immutable ledger
    000.json          # seed
    001.json          # security pass (or rejected -- status lives inside the file)
    002.json          # cfo pass
    ...
  logs/               # raw token streams, one per agent + execution log
    execution.log
    agent-main.log
    agent-security.log
```

**Rules:**
- Metadata lives inside the JSON, never in filenames. Filenames are sequential
  numbers, nothing more.
- `snowball.json` is a bomber copy (not a symlink) of the latest valid history
  entry. Disk is cheap; corruption is expensive.

### 5. Atomic Writes & Crash Recovery

All state writes use POSIX atomic rename:
1. Write `target.json.tmp`
2. `fsync`
3. `rename(tmp, target)` -- atomic on POSIX

`joust run` implicitly resumes. On boot it scans `history/`, ignores `.tmp`
files, falls back to the highest-numbered valid JSON. If a file is corrupted
(e.g., disk full), log a warning and fall back to the previous entry. Re-queue
the agent that was interrupted.

A `kill -9` at any point leaves at worst an orphaned `.tmp`. Read consistency is
always guaranteed.

### 6. Configuration (`rfc.yaml`)

Evaluated statelessly at round boundaries (on boot, after interactive pauses).
User can edit between rounds to add/remove/swap agents mid-flight.

Environment variables expand natively: `$ANTHROPIC_API_KEY` in the YAML is
resolved via `process.env` at parse time. Missing vars throw a loud error before
any API call.

```yaml
defaults:
  temperature: 0.2
  max_retries: 3
  compaction_threshold: 10

agents:
  main:
    model: claude-opus-4-6
    api_key: $ANTHROPIC_API_KEY
    system: >
      You are the lead architect. You own the core vision.
      Before any peer review, define strict RFC 2119 invariants.
      Protect these invariants across all revisions.

  security:
    model: gemini-2.5-pro
    api_key: $GEMINI_API_KEY
    system: >
      You are a ruthless security auditor. Mutate the draft to close
      vulnerabilities, but you MUST respect the invariants.

  cfo:
    model: claude-sonnet-4-6
    api_key: $ANTHROPIC_API_KEY
    system: >
      You are the CFO. Mutate the draft to optimize for cost and margin,
      but you MUST respect the invariants.
```

Config resolution order: built-in defaults < `~/.joust/config.yaml` < `./rfc.yaml`

### 7. Execution Model

#### Phase 0: Bootstrap (`joust init` / `joust draft`)

User provides raw input (string, `.md` file, or `$EDITOR` if no args). `main`
expands it into an initial draft + invariants. Writes `history/000.json`.

If invoked via `joust init`, execution stops here. The user reviews/edits
`rfc.yaml` and `snowball.json` before proceeding.

#### Phase 1..N: The Accumulator Loop

```
for each round:
  reload rfc.yaml
  for each jouster in config order:
    compile context ("Attention Sandwich")
    jouster mutates draft (full rewrite, always)
    main lints mutation against invariants
    if invalid:
      retry up to max_retries (with rejection feedback in prompt)
      if exhausted: trip circuit breaker -> human intermission
    if valid:
      atomic write to history/ and snowball.json
  main polishes draft at end of round
```

#### Context Compilation ("Attention Sandwich")

Each one-shot API call is structured to exploit LLM attention mechanics:

| Position | Content | Why |
|----------|---------|-----|
| **Top** (system) | Persona + invariants | Anchors behavior |
| **Middle** (user/assistant turns) | Critique trail / history as pseudo-conversation | Narrative > wall of text |
| **Bottom** (final user msg) | Current draft to mutate | Recency bias ensures focus |

#### Output

- **STDOUT:** final clean Markdown only
- **STDERR:** all UI, progress, spinners, status
- Fully pipeable: `joust draft "mobile api" | pandoc -o spec.pdf`

### 8. CLI Commands

| Command | Description |
|---------|-------------|
| `joust init <prompt>` | Bootstrap directory, write config, pause for editing |
| `joust init` (no args) | Open `$EDITOR` for prompt input |
| `joust draft <prompt>` | Bootstrap + immediately execute full loop |
| `joust run [dir]` | Start or resume the accumulator loop |
| `joust tail [dir]` | Stream `logs/` in real-time, color-coded by agent |

### 9. Execution Flags

#### `--interactive[=N]`

Pause for human feedback every N rounds (default 1). At pause:
- `main` synthesizes current state into a dashboard (word count, invariant
  counts, key conflicts, retry stats)
- Spawns `$EDITOR` with pre-populated questions
- User feedback enters snowball as `human_directive` (overrides all agents)

#### `--timebox <duration>`

Autonomy budget. Agents grind for the specified duration. Current API request
finishes before graceful pause. This is a soft limit (SIGTERM-style).

#### `--timeout <duration>`

Hard limit. Fires `AbortController` on inflight requests. Saves state with
aborted status. Can combine with `--timebox`:
`joust run --timebox 45m --timeout 50m`

#### `--tank`

Unstoppable mode. The engine does not crash.
- **429 Rate Limits:** exponential backoff, wait and retry
- **5xx / timeouts:** skip the agent for this round, log `SYSTEM_FAILURE` in
  the trail, try them again next round (no grudges)
- **Bad structured output:** retry parse, then skip

Combine for maximum autonomy: `joust run --timebox 1h --tank`

### 10. The Human-in-the-Loop Model

The user is the Product Owner. They can intervene at any pause point:

- **Edit `rfc.yaml`**: add/remove/swap agents, change prompts, adjust retries
- **Edit `snowball.json`**: add/remove invariants, modify the draft directly
- **Write feedback via `$EDITOR`**: injected as `human_directive`, highest
  priority in the next context compilation
- **Circuit breaker trips**: engine pauses automatically when a jouster
  exhausts retries, giving the user full control to fix the agent, fire the
  agent, relax the constraint, or override manually

### 11. External Tooling Hook

`joust` acts as a stateless pass-through when pointed at an existing directory:

```
joust --dir ./my-api --agent cfo "why did you drop redis?"
```

Reads disk state, prepopulates context for the specified agent, executes one API
call, returns response on STDOUT. Does not run the state machine. This supports
integration with Claude Code slash commands, MCP servers, or wrapper scripts.

### 12. Utilities Module

Abstract into `src/utils.ts`:
- `writeAtomic(path, data)` -- the `.tmp` -> `fsync` -> `rename` dance
- `loadAndExpandConfig(path)` -- YAML parse + `$ENV_VAR` expansion
- `readSnowball(dir)` -- find latest valid history entry, return parsed state
- `slugify(prompt)` -- derive directory name from prompt text

### 13. Non-Goals (v1)

- Parallel agent execution (sequential accumulator is the architecture)
- Custom REPL / interrogation modes during intermission (the filesystem is the
  interface; keep it dumb)
- Diff-based output from jousters (always full rewrite for structural integrity)
- Token golfing (eat the cost, get robustness)
- Web UI
