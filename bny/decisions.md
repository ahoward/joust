# Decisions

Append-only log of architectural decisions.

---

## 2026-04-14: initial architecture

- sequential snowball accumulator over parallel MapReduce (avoids O(n^2) token inflation)
- RFC 2119 invariant enforcement (MUST/SHOULD/MUST NOT) with retry on violation
- YAML config for humans, pretty JSON for machine state
- bomber filesystem: atomic writes, copies not symlinks, metadata inside files not filenames
- compiled bun binary with vercel AI SDK for unified provider access
- STDOUT = markdown only, STDERR = everything else (unix citizen)
- `--tank` mode for unstoppable execution (backoff on 429s, skip dead endpoints)
- full draft rewrites every pass (structural integrity over token golfing)
- compaction threshold default 10 (amortized for modern large context windows)

## 2026-04-14: history filenames

- history files use `NNN-slug.json` pattern (e.g., `001-security.json`, `002-cfo.json`)
- the agent slug makes `ls history/` immediately legible without opening files
- status metadata (rejected, passed, aborted) still lives inside the json, not the filename
- this is structural info (who), not status info (what happened) -- different from encoding REJECTED into filenames
