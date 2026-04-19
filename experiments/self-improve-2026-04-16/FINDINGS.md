# Experiment: Joust Self-Improvement (2026-04-16)

## Hypothesis

If joust works correctly, it should be able to review its own codebase and produce
actionable improvements. We ran 11 rounds of adversarial review with the prompt:

> Review the joust codebase — all files under src/ and test/ — and produce a
> concrete improvement plan.

## Setup

- Branch: `joust-self-improve`
- Config: 3 agents (main/opus, security/sonnet, cfo/sonnet), 11 max rounds
- Prompt included instruction to cite exact files and provide before/after snippets

## Results

The run completed successfully:

- 36 history steps across 11 rounds
- 0 lint rejections (all mutations respected invariants)
- 10 critique trail entries after compaction
- 2 resolved decision summaries
- Final draft: ~6,300 words, 15 concrete improvement items

The agents converged quickly. By round 4, security and CFO passes were returning
the draft verbatim with notes like "no changes warranted." The plan is well-structured
with phased rollout, dependency ordering, and effort estimates.

## Problem: 14 of 15 Items Are Hallucinated

Verification against the actual source code revealed that **14 of 15 proposed
improvements reference code that does not exist**:

| Item | File Cited | Verdict |
|------|-----------|---------|
| 1 | src/errors.ts | Valid (but mischaracterizes current code) |
| 2 | src/config.ts | Hallucinated — references `loadConfig()`, actual: `resolve_config()` |
| 3 | src/ai.ts | Hallucinated — references `callModel()`, actual: Vercel AI SDK |
| 4 | src/context.ts | Hallucinated — references OOP `Context` class, actual: pure functions |
| 5 | src/cli.ts | Hallucinated — says to add error handling, already exists |
| 6 | src/compact.ts | Hallucinated — references `compact()`, actual: `maybe_compact()` |
| 7 | src/tank.ts | Hallucinated — references multi-model `tank()`, actual: `tank_execute()` |
| 8 | src/utils.ts | Hallucinated — references `truncate()` that doesn't exist |
| 9 | src/run.ts | Hallucinated — says to add graceful shutdown, already exists |
| 10 | src/lint.ts | Hallucinated — says `lint()` calls `process.exit()`, it doesn't |
| 11-15 | test/*.test.ts | Hallucinated — tests for non-existent functions/classes |

Key patterns:
- **Naming**: Plan uses camelCase (`loadConfig`), codebase uses `snake_case`
- **Architecture**: Plan assumes OOP (Context class), codebase is functional
- **Already done**: Items 5, 9, 10 describe problems already solved

## Root Cause

Joust agents operate on the **snowball** (draft + invariants + critique trail).
They never see actual source files. The initial prompt said "review all files under
src/ and test/" but the agents could only imagine what those files contain.

The agents hallucinated a plausible-but-wrong codebase. The adversarial process
then refined this hallucination into a polished, internally consistent plan that
has no connection to reality.

## Conclusion

**The joust process works.** Agents converge, respect invariants, refine each
other's work, and produce coherent output. The failure mode is not in the process
but in the **input**: agents need to see the actual code to review it.

This proves the need for a mechanism to inject source files into agent context,
such as:
- An `attachments` field in rfc.yaml that inlines file contents into the draft
- A `--context-files` flag that prepends source to the prompt
- A tool-use integration that lets agents read files on demand

Without this, joust is limited to reviewing documents, not code.

## Files

- `rfc.yaml` — config used for the run
- `final-draft.md` — the 15-item improvement plan (hallucinated)
- `stats.txt` — run statistics
