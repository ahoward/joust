<p align="center">
  <img src="media/logo.svg" alt="joust" width="480"/>
</p>

<p align="center">
  <em>LLMs don't agree. Make them fight about it.</em>
</p>

<p align="center">
  <code>joust draft "design a zero-downtime migration strategy for 50M rows" | pandoc -o spec.pdf</code>
</p>

---

## what

`joust` is a compiled CLI that runs adversarial peer review across a ranked
panel of LLM agents. a lead architect agent seeds an initial design, extracts
strict RFC 2119 invariants (`MUST`, `SHOULD`, `MUST NOT`), and then rolls the
draft through a gauntlet of persona-driven jousters -- security auditors, CFOs,
DBAs, performance skeptics -- who each tear it apart and rewrite it under the
architect's enforcement.

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
  [security] -- mutates draft under invariant constraints
    |
    v
  [main] -- lints mutation, rejects or accepts
    |
    v
  [cfo] -- mutates draft under invariant constraints
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

requires `ANTHROPIC_API_KEY` in your environment.

## quick start

```bash
# bootstrap a new architecture review
joust init "realtime bidding engine, must handle 100k qps, no vendor lock-in"

# edit the config -- swap agents, tune prompts, add invariants
$EDITOR ./realtime-bidding-engine/rfc.yaml

# let them fight
joust run ./realtime-bidding-engine

# watch the models argue in real-time from another terminal
joust tail ./realtime-bidding-engine
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
realtime-bidding-engine/
  rfc.yaml              # your config. edit between rounds.
  snowball.json         # current state (pretty json, atomic copy)
  history/              # append-only immutable ledger
    000-main.json       # seed
    001-security.json   # security pass
    002-cfo.json        # cfo pass
  logs/                 # raw token streams
    execution.log
    agent-security.log
```

filenames use `NNN-slug.json` so `ls history/` tells the story at a glance.
status (rejected, passed, aborted) lives inside the json, not the filename. state survives
`kill -9` via atomic writes (`.tmp` -> `fsync` -> `rename`). `joust run` always
resumes.

## config

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
      You are the lead architect. Define and enforce
      strict RFC 2119 invariants across all revisions.

  security:
    model: claude-sonnet-4-6
    api_key: $ANTHROPIC_API_KEY
    system: >
      You are a ruthless security auditor. Close every
      hole, but respect the architect's invariants.

  cfo:
    model: claude-sonnet-4-6
    api_key: $ANTHROPIC_API_KEY
    system: >
      You are the CFO. Optimize for cost and margin,
      but respect the architect's invariants.
```

keys use env var expansion (`$ANTHROPIC_API_KEY`). config is re-read at every
round boundary -- swap agents mid-flight by editing the yaml during a pause.

## execution flags

```bash
# human-in-the-loop: pause every 3 rounds, open $EDITOR for feedback
joust run --interactive=3

# autonomy budget: grind for 1 hour then page me
joust run --timebox 1h

# tank mode: exponential backoff on 429s, skip dead endpoints, never crash
joust run --tank

# combine for maximum autonomy
joust run --timebox 1h --tank --interactive=5
```

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
