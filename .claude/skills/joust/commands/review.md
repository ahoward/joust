# /joust review

User intent: see how the latest joust run scored — strategies, dimensions, where it lost points.

## Args

- `[dir]` — optional. Defaults to most recent `.joust/<slug>/` in cwd.

## Steps

### 1. Install bootstrap

From SKILL.md.

### 2. Resolve dir

Same as `pickup` step 2.

### 3. Fetch structured export

```sh
"$JOUST" /export "$DIR" --json
```

JSON has:
- `draft` — the best draft text.
- `best_aggregate` — overall score.
- `best_color_tier` — `red`/`yellow`/`green`/`null`.
- `scorecards[]` — per-strategy:
  - `strategy` name
  - `aggregate` (0..1)
  - `dimensions[]` with `name`, `score`, `max`, `weight`, `floor`, `rationale`
  - optional `color_tier` (only on color strategy)
- `strategies` — the configured strategies (rubric dims, invariants rules, color question).

### 4. Render to conversation

Format as readable markdown:

```markdown
## joust review — <DIR>

**Best aggregate:** 0.847 (color tier: green)

**Strategies:**
- rubric (aggregate 0.81)
  - clarity: 8/13 — "concise but missing examples"
  - security: 13/13 — "covers all listed threats"
  - completeness: 5/13 — "skips error cases"
- invariants (aggregate 0.92)
  - MUST: atomic writes ✓
  - MUST: no secrets in logs ✓
  - SHOULD: prefer existing utils ✗ — "introduced new helper"

**Where it lost points:**
- rubric/completeness: 5/13 — error cases not addressed
- invariants/SHOULD-prefer-existing-utils: 0/13 — new helper introduced

**To improve:** could re-run with feedback (`/joust pickup` then add a human directive in config), or accept and ship.
```

Tailor the rendering based on which strategies are configured. If only one strategy, simplify. If no scoring at all (legacy run), say so and suggest the operator re-init to get strategies.

### 5. No mutation

This command is read-only. Never edit config.json, history, or run anything from review.
