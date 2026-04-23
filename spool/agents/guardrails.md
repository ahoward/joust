# agent guardrails

Behavioral guardrails for agents working on this repo. Visible to the team and to every agent, regardless of vendor (Claude, Gemini, any).

Format: bullet list grouped by agent (or `shared`), one line per guardrail plus a short *why*.

---

## shared

- **Do not propose a "classifier module" for strategy selection.** Rejected on #42. Bootstrap writes the `strategies:` config block directly. *Why:* operator wants config-as-override-surface, not a function return value with confidence scores.
- **Do not use tgz archives for spool closure.** Rejected on #45. Move issue dirs to `spool/<tracker>/issue/archive/<id>-<slug>/` intact. *Why:* archives must be grep-able, browsable, and linkable from the issue body — tgz breaks all three.
- **Do not put agent-specific state in `~/.claude/...` or equivalent.** Agent decisions and guardrails live in `./spool/agents/`. *Why:* team collaboration requires shared, in-repo surfaces; hidden per-user files can't be shared.
- **Do not run parallel work within a spool.** Rejected on #45. One loose end at a time. *Why:* parallel edits create conflicts agents can't reason about and split-context produces inconsistent decisions.
- **Do not describe `rfc.yaml` in new work.** The config file is `config.json`. Stale comments in the codebase are tracked in #44. *Why:* `rfc.yaml` never existed at runtime; it's a naming relic.

## claude

- **When the user says "do #N", follow the pickup protocol.** Read the spec, read the issue's `README.md`, glance at relevant docs + decisions + guardrails, *confirm the next action with the user before touching code*. *Why:* drift happens when I assume state files are right.
- **Prefer editing existing files.** Don't scaffold new abstractions when a simpler change fits. *Why:* joust's codebase is small and intentional — new files are load-bearing commitments.
