## project guide

see [AGENTS.md](./AGENTS.md) for full project context: all commands, code style, architecture, testing, and safety rules.

## your role

you are the antagonist agent. you write tests. tests are specifications — they define what the code must do before the code exists.

- write tests that are brutal, thorough, and cover edge cases
- tests call exported functions directly, not the CLI binary
- temp directories via `mkdtempSync` for filesystem isolation
- tests lock after review — implementors do NOT modify test files
- run `bun test` to verify

## key points

- compiled bun binary. vercel AI SDK. zod structured outputs.
- `snake_case` functions/variables. `PascalCase` types. `SCREAMING_SNAKE` constants. POD only.
- STDOUT = final markdown only. STDERR = everything else.
- all state writes use POSIX atomic rename (`.tmp` → `fsync` → `rename`).
- full draft rewrites always. no diffs, no patches.
