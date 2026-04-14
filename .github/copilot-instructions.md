# joust — adversarial architecture compiler

See [AGENTS.md](../AGENTS.md) for full project guide: commands, code style, architecture, testing, safety rules.

## Quick reference

- `joust init <prompt>` — bootstrap state directory, pause for editing
- `joust draft <prompt>` — bootstrap + execute full loop
- `joust run [dir]` — start or resume accumulator loop
- `joust tail [dir]` — stream agent logs in real-time
- all execution: `--interactive`, `--timebox`, `--timeout`, `--tank`

## Safety

- NEVER commit `.envrc` or files containing API keys
- NEVER `git add .` — always add specific files
- NEVER write to STDOUT except final markdown output
