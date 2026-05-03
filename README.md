<p align="center">
  <img src="media/logo.svg" alt="joust" width="480"/>
</p>

<p align="center">
  <em>LLMs don't agree. Make them fight about it.</em>
</p>

<p align="center">
  <code>joust "design a zero-downtime migration strategy for 50M rows" | pandoc -o spec.pdf</code>
</p>

---

## what

`joust` is a compiled CLI that runs adversarial peer review across a ranked
panel of LLM agents. a lead architect agent seeds an initial design, extracts
strict RFC 2119 invariants (`MUST`, `SHOULD`, `MUST NOT`), and then rolls the
draft through a gauntlet of persona-driven jousters -- security auditors, CFOs,
DBAs, performance skeptics -- who each tear it apart and rewrite it under the
architect's enforcement.

every agent has read-only access to your project files via built-in tools
(`read_file`, `list_files`, `search_files`). they ground their analysis in
actual code -- no hallucinated file paths, no invented line numbers.

the output is hardened by conflict. not softened by consensus.

## why

a single LLM pass on a complex technical question has one failure mode:
**confident, well-structured, and completely wrong.**

parallel multi-agent approaches blow up to O(n^2) token inflation and produce
wishy-washy compromises. `joust` replaces that with a sequential accumulator
("the snowball") where each agent must resolve conflicts in real-time, under
invariant constraints, or get bounced.

## how it works

```
  prompt
    |
    v
  [main] -- seeds draft, extracts MUST/SHOULD/MUST NOT invariants
    |
    v
  [security] -- mutates draft (has file access to your codebase)
    |
    v
  [main] -- lints mutation against invariants (has file access)
    |
    v
  [cfo] -- mutates draft (has file access to your codebase)
    |
    v
  [main] -- lints, polishes, outputs
    |
    v
  stdout (clean markdown)
```

every step is saved to an append-only ledger on disk. atomic POSIX writes. you
can `kill -9` the process mid-stride, restart it, and the snowball picks up
exactly where it left off.

## install

```bash
curl -fsSL https://raw.githubusercontent.com/ahoward/joust/main/install.sh | bash
```

or pick a binary from the [latest release](https://github.com/ahoward/joust/releases/latest) and drop it in your `$PATH`.

### from source

```bash
git clone https://github.com/ahoward/joust.git
cd joust
bun install
bun build ./src/cli.ts --compile --outfile joust
sudo cp joust /usr/local/bin/
```

## setup

joust auto-detects your API keys and picks the best preset:

| env var | preset |
|---------|--------|
| `ANTHROPIC_API_KEY` only | `anthropic` -- opus main + sonnet jousters |
| `GOOGLE_GENERATIVE_AI_API_KEY` only | `gemini` -- gemini-2.5-pro all agents |
| `OPENAI_API_KEY` only | `openai` -- gpt-4o all agents |
| multiple keys set | `mixed` -- opus main + gemini security + gpt-4o cfo |

override with `--preset`: `joust --preset gemini "my prompt"`

## quick start

```bash
# just give it a prompt -- auto-detects provider, bootstraps, runs, outputs to stdout
joust "realtime bidding engine, must handle 100k qps, no vendor lock-in"

# or split bootstrap from execution
joust /init "realtime bidding engine"
$EDITOR .joust/realtime-bidding-engine/config.json # edit config, swap agents, tune prompts
joust /run .joust/realtime-bidding-engine           # let them fight

# watch the models argue in real-time from another terminal
joust /tail .joust/realtime-bidding-engine
```

## using joust from an AI coding agent

joust is designed to be invoked from within AI coding agents like Claude Code,
Gemini CLI, Cursor, Windsurf, Cline, etc. the `/` command syntax was designed
for this -- it mirrors slash commands in Claude Code and similar tools.

### Claude Code: skill (recommended)

joust ships a Claude Code skill at `.claude/skills/joust/`. clone this repo,
start a Claude Code session in it, and the agent will discover the skill
automatically. four subcommands:

```
/joust draft <prompt>    # bootstrap + run, with confirmation
/joust pickup [dir]      # resume the latest in-progress run
/joust review [dir]      # show scores in detail
/joust status [dir]      # one-line summary
```

the skill's first invocation auto-installs the joust binary if missing,
verifies its checksum, and pins to a compatible version range. uses
`joust /status --json` and `joust /export --json` to read state, never
parses human-formatted stdout.

if you want the skill available in any repo (not just this one), copy
`.claude/skills/joust/` to `~/.claude/skills/joust/`.

### Claude Code: simple slash command

if you prefer a thin passthrough instead of the skill, add a slash command to your project:

```bash
mkdir -p .claude/commands
cat > .claude/commands/joust.md << 'JOUST'
---
allowed-tools: Bash(joust:*)
description: Run joust — adversarial architecture compiler
argument-hint: <prompt> or /<command> [args...]
---

Run joust as a CLI passthrough. The user's arguments are passed verbatim.

Run the following command and return the full output to the user:

```
joust $ARGUMENTS 2>&1
```

Return ALL output (stdout + stderr) directly — do not summarize or truncate.
JOUST
```

then from Claude Code:

```
/joust design a caching layer for mobile APIs
/joust /status .joust/my-project/
/joust /run .joust/my-project/ --tank
```

### other agents

any agent that can run shell commands can use joust:

```bash
# bare prompt -- the common case
joust "design an auth middleware for express, must support OAuth2 and API keys"

# pipe output into your workflow
joust "review src/ for security issues" > security-review.md
```

## CLI reference

```
usage:
  joust <prompt>              bare string = bootstrap + run
  joust /prompt <prompt>      explicit prompt (escapes prompts starting with /)
  joust /init <prompt>        bootstrap state directory only
  joust /run [dir]            start or resume accumulator loop
  joust /tail [dir]           stream agent logs in real-time
  joust /status [dir]         show current run status
  joust /export [dir]         output latest draft to stdout
  joust /diff [dir] [a] [b]   diff between two history steps
  joust /plan [dir]           estimate token usage and cost
  joust /ask [dir] <agent> <question>

flags:
  --preset <name>         agent preset (auto-detected from env by default)
  --interactive[=N]       pause every N rounds for human feedback
  --timebox <duration>    autonomy budget (e.g., 45m, 1h)
  --timeout <duration>    hard kill limit
  --tank                  unstoppable mode (backoff 429s, skip 5xx)

presets:
  anthropic               opus main + sonnet jousters
  gemini                  gemini-2.5-pro all agents
  openai                  gpt-4o all agents
  mixed                   opus main + gemini security + gpt-4o cfo
```

the `/prompt` command exists for when your prompt text itself starts with `/`:

```bash
joust /prompt "/usr/local/bin must support sandboxed execution for all plugins"
```

## the snowball

the core state object that rolls from agent to agent:

```json
{
  "invariants": {
    "MUST": ["handle 100k qps at p99 < 50ms"],
    "SHOULD": ["prefer managed services over self-hosted"],
    "MUST_NOT": ["introduce vendor lock-in beyond AWS primitives"]
  },
  "draft": "# Bidding Engine Architecture v3\n...",
  "critique_trail": [
    { "actor": "security", "action": "mutated_draft", "notes": "added mTLS between services" },
    { "actor": "cfo", "action": "mutated_draft", "notes": "replaced NAT gateway with VPC endpoints, saves $4k/mo" }
  ]
}
```

jousters **must** produce a full rewrite of the draft every pass. no diffs, no
patches. structural integrity over token golfing.

## the filesystem is the database

```
.joust/2026-04-20--realtime-bidding-engine/
  config.json           # your config. edit between rounds. pretty JSON.
  snowball.json         # current state (pretty json, atomic copy)
  history/              # append-only immutable ledger
    000-main.json       # seed
    001-peer.json       # peer pass
    002-security.json   # specialist pass (if summoned)
  logs/                 # per-agent + system logs
    stderr.txt          # full stderr capture (what you saw in the terminal)
    stdout.txt          # full stdout capture (final draft bytes)
    execution.log       # system events
    agent-main.log      # raw pass-through of every main API call (prompt, tool calls, output)
    agent-peer.log      # same, for peer
    agent-security.log  # same, for any specialist summoned this run
```

filenames use `NNN-slug.json` so `ls history/` tells the story at a glance.
status (rejected, passed, aborted) lives inside the json, not the filename. state survives
`kill -9` via atomic writes (`.tmp` -> `fsync` -> `rename`). `joust /run` always
resumes.

## config

```json
{
  "defaults": {
    "temperature": 0.2,
    "max_retries": 3,
    "compaction_threshold": 10,
    "max_rounds": 1
  },
  "agents": {
    "main": {
      "model": "claude-opus-4-6",
      "api_key": "$ANTHROPIC_API_KEY",
      "system": "You are the lead architect. Define and enforce strict RFC 2119 invariants across all revisions."
    },
    "peer": {
      "model": "gemini-2.5-pro",
      "api_key": "$GOOGLE_GENERATIVE_AI_API_KEY",
      "system": "You are a senior lead architect. Own the vision. Summon specialists when warranted."
    }
  }
}
```

keys use env var expansion (`$ANTHROPIC_API_KEY`). config is re-read at every
round boundary -- swap agents mid-flight by editing the file during a pause.

the generated default also writes a `specialist_pool` block below `agents` --
that's informational, showing what main/peer can summon (security, cfo, dba,
perf, ux, legal). move an entry into `agents` to pin it as a permanent panel
member.

agents have read-only file access to the project workspace (defaults to the
directory containing `config.json`). set `workspace` in defaults to override.

## execution flags

```bash
# human-in-the-loop: pause every 3 rounds, open $EDITOR for feedback
joust /run --interactive=3

# autonomy budget: grind for 1 hour then page me
joust /run --timebox 1h

# tank mode: exponential backoff on 429s, skip dead endpoints, never crash
joust /run --tank

# combine for maximum autonomy
joust /run --timebox 1h --tank --interactive=5
```

## agent tools

all agents (jousters, lint, polish, compact) have read-only access to the
project workspace via three tools:

| tool | description |
|------|-------------|
| `read_file` | read file contents, path relative to project root |
| `list_files` | glob match files (auto-excludes node_modules, .git) |
| `search_files` | regex search over file contents with optional glob filter |

tools are sandboxed -- path traversal and symlink escapes are blocked. agents
cannot write files, only read them.

## unix philosophy

- `STDOUT` = final markdown. pipe it anywhere.
- `STDERR` = ui, progress, logs.
- state directory = the auditable turd. always left behind.
- `$EDITOR` = the human override interface.
- single compiled binary. zero runtime deps.

## status

working. ships as a single binary for linux and macOS (x64 + arm64).

## license

MIT
