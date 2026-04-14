## project guide

see [AGENTS.md](./AGENTS.md) for full project context: all commands, code style, architecture, testing, and safety rules.

## key points

- compiled bun binary. vercel AI SDK for unified provider access. zod for structured outputs.
- `snake_case` functions/variables. `PascalCase` types. `SCREAMING_SNAKE` constants. POD only.
- STDOUT = final markdown only. STDERR = everything else.
- all state writes use POSIX atomic rename (`.tmp` → `fsync` → `rename`).
- full draft rewrites always. no diffs, no patches. structural integrity over token golfing.
- run `./dev/test` after code changes. run `./dev/post_flight` before commits.
- never `git add .` — always add specific files.
