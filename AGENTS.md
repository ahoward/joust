# joust — agent guide

> Compatible with: Claude Code, Gemini CLI, Cursor, Windsurf, GitHub Copilot, Cline, Aider, Zed AI, Continue, RooCode, and any MCP-compatible tool.

adversarial architecture compiler. LLMs don't agree — make them fight about it. compiled bun binary. sequential snowball accumulator with RFC 2119 invariant enforcement.

## quick start

```bash
joust init "design a zero-downtime migration strategy"   # bootstrap directory, pause for editing
joust run ./zero-downtime-migration/                      # start or resume the accumulator loop
joust tail ./zero-downtime-migration/                     # stream agent logs in real-time
joust draft "fast api for mobile app, read-only postgres" # bootstrap + execute in one shot
```

---

## all commands

| command | description | example |
|---------|-------------|---------|
| `joust init <prompt>` | bootstrap state directory, write config, pause | `joust init "mobile api"` |
| `joust init` (no args) | open `$EDITOR` for prompt input | `joust init` |
| `joust draft <prompt>` | bootstrap + immediately execute full loop | `joust draft "realtime bidding engine"` |
| `joust run [dir]` | start or resume the accumulator loop | `joust run ./my-api/` |
| `joust tail [dir]` | stream `logs/` in real-time, color-coded by agent | `joust tail ./my-api/` |

## execution flags

| flag | description |
|------|-------------|
| `--interactive[=N]` | pause for human feedback every N rounds (default 1) |
| `--timebox <duration>` | autonomy budget — soft limit, lets inflight request finish |
| `--timeout <duration>` | hard limit — fires AbortController on inflight requests |
| `--tank` | unstoppable mode: backoff on 429s, skip dead endpoints, never crash |

combine for maximum autonomy: `joust run --timebox 1h --tank --interactive=5`

## code style

- **functions/variables**: `snake_case` (e.g., `write_atomic`, `load_config`, `compile_context`)
- **types**: `PascalCase` (e.g., `Snowball`, `AgentConfig`, `LintResult`)
- **constants**: `SCREAMING_SNAKE` (e.g., `MAX_RETRIES`, `DEFAULT_TEMPERATURE`)
- **data**: POD only — no classes for data containers. interfaces and type aliases only.
- **output**: STDOUT is reserved strictly for final markdown. all UI/progress/logs go to STDERR.
- **null over undefined** where possible
- **full rewrites always** — jousters output the complete draft every pass. no diffs, no patches.

## architecture

```
src/cli.ts          entry point, command dispatch
src/init.ts         bootstrap: phase 0, $EDITOR, slug generation
src/run.ts          the accumulator loop (sequential agent execution)
src/lint.ts         invariant validation (main lints jouster output via Zod)
src/context.ts      "attention sandwich" — compile snowball into LLM message array
src/compact.ts      critique trail compaction (GC pass)
src/ai.ts           vercel AI SDK wrappers (unified provider access)
src/config.ts       YAML config loader with $ENV_VAR expansion
src/state.ts        snowball read/write, history management
src/utils.ts        atomic writes, slugify, file helpers
src/tail.ts         log streaming (color-coded by agent)
src/interactive.ts  $EDITOR integration, human intermission dashboard
```

data flow: `cli.ts → config.ts (load yaml) → run.ts (loop) → context.ts (compile) → ai.ts (call) → lint.ts (validate) → state.ts (atomic write)`

## the snowball (state object)

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

## state directory layout

```
<project-slug>/
  rfc.yaml              human-editable config (personas, keys, limits). re-read per round.
  snowball.json         current working state (pretty JSON, bomber atomic copy)
  history/              append-only immutable ledger
    000-main.json       seed (main bootstrap)
    001-security.json   security pass
    002-cfo.json        cfo pass
  logs/                 raw token streams
    execution.log       system events (retries, timeouts, kills)
    agent-main.log      raw token stream from main
    agent-security.log
```

rules:
- filenames use `NNN-slug.json` where slug is the agent name from config
- status metadata (rejected, passed, aborted) lives inside the json, not the filename
- `snowball.json` is a bomber copy (not a symlink)
- all writes use POSIX atomic rename (`.tmp` → `fsync` → `rename`)

## execution model

1. **phase 0 (bootstrap)**: main agent expands raw prompt into initial draft + RFC 2119 invariants
2. **phase 1..N (accumulator loop)**: each jouster receives compiled context, mutates draft, main lints against invariants
3. **retry**: if jouster violates invariants, rejection feedback is appended to their prompt, they retry up to `max_retries`
4. **circuit breaker**: if retries exhausted, execution pauses for human intervention
5. **compaction**: every N rounds (default 10), main compresses critique trail into resolved decisions

context compilation uses the "attention sandwich":
- **top** (system): persona + invariants (anchors behavior)
- **middle** (user/assistant turns): critique trail as pseudo-conversation
- **bottom** (final user msg): current draft to mutate (recency bias)

## config format (rfc.yaml)

```yaml
defaults:
  temperature: 0.2
  max_retries: 3
  compaction_threshold: 10

agents:
  main:
    model: claude-opus-4-6
    api_key: $ANTHROPIC_API_KEY
    system: "You are the lead architect..."
  security:
    model: gemini-2.5-pro
    api_key: $GEMINI_API_KEY
    system: "You are a ruthless security auditor..."
```

- env vars expand natively: `$ANTHROPIC_API_KEY` resolves via `process.env`
- config is re-read at round boundaries — swap agents mid-flight by editing during a pause
- resolution order: built-in defaults < `~/.joust/config.yaml` < `./rfc.yaml`

## testing

```bash
bun test              # run all tests
./dev/test            # same, via dev script
./dev/post_flight     # run before commits
```

- tests call exported functions directly, not the CLI binary
- temp directories via `mkdtempSync` for filesystem isolation
- tests are written by the antagonist agent — **do NOT modify test files**

## build

```bash
bun build ./src/cli.ts --compile --outfile joust    # single binary, zero runtime deps
```

## safety rules

1. **NEVER** `git add .` or `git add -A` — always add specific files
2. **NEVER** commit `.envrc` or files containing API keys
3. **NEVER** force push to main
4. **NEVER** skip tests before committing
5. STDOUT is sacred — only final markdown output touches it. everything else goes to STDERR.

## i/o contract

- `STDOUT` = final clean markdown only. pipe it: `joust draft "..." | pandoc -o spec.pdf`
- `STDERR` = all UI, spinners, progress, status, errors
- state directory = the auditable turd. always left behind on disk.
- `$EDITOR` = the human override interface
