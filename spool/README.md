# spool (joust)

This directory follows the **spool** convention for serial multi-session work.

Canonical spec: https://github.com/ahoward/spool

## Layout

```
./spool/
  docs/                        # evolving specs, one per subsystem
  agents/                      # agent decisions + guardrails
  gh/issue/<id>-<slug>/        # live per-issue working dirs
  gh/issue/archive/            # closed issues, moved intact
```

## Live

- `gh/issue/42-strategy-scoring/` — replace single-anchor lint with weighted strategy mix
