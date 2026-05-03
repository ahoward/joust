---
name: joust
description: Run joust — an adversarial architecture compiler that uses two antagonistic LLMs plus pluggable scoring strategies. Use only when the user types one of `/joust draft`, `/joust pickup`, `/joust review`, or `/joust status`. Do NOT invoke implicitly.
---

# joust

Joust is a CLI binary that takes a prompt and runs an adversarial loop: two LLMs from different providers iteratively refine a draft, with pluggable scoring strategies (rubric, invariants, color) selecting the best output. Source: https://github.com/ahoward/joust.

This skill is a thin wrapper. The real work lives in the binary. The skill knows when to reach for joust, how to install it, and how to translate its `--json` output back into conversation.

## Hard rules

1. **Explicit only.** This skill runs only when the user types a `/joust …` command. Never fire from casual mentions of "design" or "architecture" in conversation.
2. **Binary version contract.** This skill requires `joust >= 0.2.0`. Each subcommand checks `joust --version` and re-installs if the binary is missing or out of range. Never proceed against an older joust.
3. **Trust the binary, don't reimplement it.** All loop logic, scoring math, file locking, and provider orchestration lives in the binary. The skill never mutates `.joust/<slug>/` directly. If a behavior change is needed, file an issue against joust.
4. **Use `--json` for state reads.** When this skill needs to know what's in a snowball, call `joust /status --json` or `joust /export --json` and parse the JSON. Never grep human-formatted stdout.
5. **Workspace = current repo.** Joust runs against `process.cwd()` as its workspace by default. The skill should `cd` to the project root before invoking joust.

## Install bootstrap (run by every subcommand)

Each subcommand begins by ensuring `joust` is available and compatible. The pattern:

```sh
# 1. find joust on PATH or via prior JOUST_BINARY hint
JOUST="${JOUST_BINARY:-$(command -v joust 2>/dev/null || true)}"

# 2. version check (skill requires >= 0.2.0 < 1.0.0)
NEEDS_INSTALL=1
if [ -n "$JOUST" ]; then
  CURRENT="$("$JOUST" --version 2>/dev/null | sed 's/^v//')"
  case "$CURRENT" in
    0.[2-9]*|0.[1-9][0-9]*) NEEDS_INSTALL=0 ;;
  esac
fi

# 3. install if missing or out of range. capture JOUST_BINARY hint if PATH unset.
if [ "$NEEDS_INSTALL" = "1" ]; then
  INSTALL_OUTPUT="$(curl -fsSL https://github.com/ahoward/joust/releases/latest/download/install.sh | sh)"
  echo "$INSTALL_OUTPUT"
  HINT="$(echo "$INSTALL_OUTPUT" | grep -oE 'JOUST_BINARY=.*' | tail -1 | cut -d= -f2)"
  JOUST="${HINT:-$(command -v joust 2>/dev/null || echo "$HOME/.local/bin/joust")}"
fi

# 4. proceed with the actual command
"$JOUST" /<command> ...
```

When a subcommand needs to invoke joust, run that bootstrap first, then the command, in a single shell invocation. Do not split across tool calls.

## API keys

Joust reads provider API keys from environment variables (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`). The skill does not manage keys. If joust errors with "missing env var X", surface that to the user — they need to set it themselves (typically via `.envrc`, `direnv`, or shell init).

## Routing

Route to the matching command playbook in `commands/`:

| User types | Playbook |
|---|---|
| `/joust draft <prompt>` | `commands/draft.md` |
| `/joust pickup [dir]` | `commands/pickup.md` |
| `/joust review [dir]` | `commands/review.md` |
| `/joust status [dir]` | `commands/status.md` |

If the user types `/joust` with no subcommand, list the four subcommands and ask which they want.

If the user types `/joust <unknown>`, list the four valid subcommands.

## When NOT to invoke joust

- Trivial single-step tasks. "Rename foo to bar" doesn't need adversarial review.
- Pure exploration. "Look at this codebase and tell me what's there." Joust is for *producing* artifacts, not *understanding* them.
- Anything that could be done in one or two LLM turns directly. Joust adds 5-30 minutes of wall time and N agent calls; only pull it in when iterative refinement is genuinely warranted.

## Output handling

Every joust subcommand surfaces back to the user in conversation. Never just dump `--json` raw — translate into a paragraph:
- Configured strategies (which apply, which declined and why).
- Best aggregate + color tier (when set).
- Trajectory if multi-round.
- Pending summon if any (a specialist is mid-attempt).
- Where the artifacts live (`.joust/<slug>/`).
