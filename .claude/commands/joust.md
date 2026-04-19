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

Return ALL output (stdout + stderr) directly — do not summarize or truncate. The output IS the response.
