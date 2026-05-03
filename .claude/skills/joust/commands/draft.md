# /joust draft

User intent: take a prompt, produce a refined artifact via joust's adversarial loop.

## Args

- `<prompt>` — required. The thing to draft. Can be a string ("design X") or a path to a file containing the prompt.
- `--rounds N` (optional) — override `max_rounds` for this run. Otherwise joust uses the config default.
- `--scorer <model>` (optional) — set `defaults.scorer_model` for cost savings. Common: `claude-haiku-4-5`.

## Steps

### 1. Confirm before spending money

Joust runs cost real LLM API spend. Before invoking:
- Surface the prompt back to the user.
- Note: this will run `joust draft "<prompt>"` against the currently configured agent panel.
- Estimate: each round = ~5-10 minutes wall time, $0.10–$2 depending on model + draft size + strategies.
- Ask the user to confirm before running.

If the user has already explicitly said "go" or "do it" with the prompt, skip the explicit confirmation but still note the cost expectation.

### 2. Install bootstrap

Run the bootstrap from `SKILL.md`. Result: `JOUST` is set to an absolute path to the binary.

### 3. Pre-flight check

- `pwd` — confirm we're in the project root (so the workspace is right).
- `echo $ANTHROPIC_API_KEY` (just the prefix, not the value) to confirm at least one provider key is set. If no keys are set, surface the error before joust dies.

### 4. Run

```sh
"$JOUST" /draft "$prompt"
```

`/draft` does init + run in one shot. Joust will:
- Bootstrap strategies (rubric, invariants, color — strategies that don't apply will decline and log it).
- Run the adversarial loop for `max_rounds` rounds.
- Stop early if plateau detected or all strategies converge to top score.
- Emit the final draft on stdout.

If the user supplied `--rounds N` or `--scorer <model>`, edit `.joust/<slug>/config.json` between init and run:

```sh
"$JOUST" /init "$prompt"             # init only, returns dir on stdout
DIR="<the dir from init output>"
# patch config.json with the overrides...
"$JOUST" /run "$DIR"
```

### 5. Report back

After the run completes, fetch structured status:

```sh
"$JOUST" /status "$DIR" --json
```

Translate to conversation. Show:
- Where the artifacts live (`$DIR`).
- Configured strategies + which declined.
- Best aggregate + color tier.
- Trajectory if multi-round.
- Recommend next: `/joust review` to see scores, or open the export draft.

### 6. Failure handling

- **Network errors / API rate limits.** Joust has tank mode. Retry suggestion: `joust /run $DIR --tank --timebox 30m`.
- **Provider key missing.** Surface to user. Do not try to set keys yourself.
- **Lock conflict (`acquire_lock` failed).** Another joust is running against the same dir. Tell the user; do not force.
- **Specialist hit `.needs-attention`.** A specialist exhausted retries. Surface the marker file contents.
