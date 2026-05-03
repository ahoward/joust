# /joust pickup

User intent: resume an in-progress joust run, or look at the latest one in the cwd.

## Args

- `[dir]` — optional. The `.joust/<slug>/` dir to resume. If absent, find the most recent one in `./.joust/`.

## Steps

### 1. Install bootstrap

From SKILL.md.

### 2. Resolve target dir

```sh
if [ -z "$1" ]; then
  # find most recent .joust/<slug>/ dir
  DIR="$(ls -td .joust/*/ 2>/dev/null | head -1)"
  if [ -z "$DIR" ]; then
    echo "no .joust/<slug>/ dirs found in $(pwd)" >&2
    exit 1
  fi
else
  DIR="$1"
fi
```

If multiple `.joust/<slug>/` exist and the user didn't specify, ask which one.

### 3. Read state

```sh
"$JOUST" /status "$DIR" --json
```

Parse the JSON. Decide what's actionable:

| State | Action |
|---|---|
| `pending_summon` is set | Tell the user a specialist is mid-attempt. Resuming will re-run that specialist with the prior rejection feedback. |
| `aggregate_history` length < `max_rounds` and last status was not "complete" | Run was interrupted. Suggest `joust /run $DIR` to continue. |
| `best_aggregate == 1.0` and trajectory plateaued | Done. Nothing to resume. Suggest `/joust review` or open export. |
| `.needs-attention` file exists | Surface it. The run is paused on a fixable problem. |

### 4. Confirm and resume

Surface the state summary, the proposed next action, and ask the user to confirm before running. Common next actions:

- `joust /run $DIR --timebox 30m` — continue the loop.
- `joust /run $DIR --tank --timebox 1h` — continue with retry tolerance.
- Edit `$DIR/config.json` first, then run (e.g. bump max_rounds, swap scorer_model).

Do not run automatically. Confirmation is the rule.

### 5. After resume completes, report

Same as `/joust draft` step 5.
