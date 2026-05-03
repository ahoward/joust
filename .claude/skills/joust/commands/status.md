# /joust status

User intent: short summary of the latest joust run — what's happening, what's next.

This is the lightweight version of `/joust review`. Use status when the user wants a one-glance summary; use review when they want to see scores in detail.

## Args

- `[dir]` — optional. Defaults to most recent `.joust/<slug>/` in cwd.

## Steps

### 1. Install bootstrap

From SKILL.md.

### 2. Resolve dir

Same as `pickup` step 2.

### 3. Get JSON status

```sh
"$JOUST" /status "$DIR" --json
```

### 4. One-paragraph summary to conversation

Render concise:

```
joust @ <DIR>: step 7 (main/polish, accepted), best agg=0.847 tier=green,
3 rounds done, strategies: rubric+invariants. No pending summon.
```

If something is actionable (pending summon, plateau, or `.needs-attention`), call it out:

```
joust @ <DIR>: step 4 (peer/mutation, rejected). Pending summon: legal
specialist asked about jurisdiction (1 prior attempt failed for
"missed clause"). /joust pickup will retry it.
```

### 5. No mutation, no run

Read-only command. For action, suggest `/joust pickup` or `/joust review`.
