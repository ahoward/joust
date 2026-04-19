---
allowed-tools: Bash(joust:*), Bash(bun run:*)
description: Run joust — adversarial architecture compiler
argument-hint: <prompt> or /<command> [args...]
---

Run joust as a CLI passthrough. The user's arguments are passed verbatim.

## Execute

Try the installed binary first, fall back to bun:

```
if command -v joust >/dev/null 2>&1; then joust $ARGUMENTS 2>&1; else bun run /home/drawohara/gh/ahoward/joust/src/cli.ts $ARGUMENTS 2>&1; fi
```

Return ALL output (stdout + stderr) directly — do not summarize or truncate. The output IS the response.
