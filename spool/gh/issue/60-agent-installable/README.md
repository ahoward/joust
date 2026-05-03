# #60 — agent-installable joust

**Spec:** https://github.com/ahoward/joust/issues/60
**Status:** ready-for-review (release workflow needs first tag to fully smoke-test)
**Branch:** `agent-installable`

## Plan

Single PR. Four coupled deliverables in dependency order:

1. **Binary changes** to `src/cli.ts`: `--version`, `/status --json`, `/export --json`.
2. **GH Actions workflow** `.github/workflows/release.yml` — build matrix with `macos-latest` (arm64), `macos-13` (x64), `ubuntu-latest` (linux-x64). Upload binaries + SHA256 sidecars on `git tag v*`.
3. **`install.sh`** — committed at repo root, also published as a release asset. Detects platform, downloads + verifies sha256, atomic mv to `~/.local/bin/joust` (override via `JOUST_INSTALL_DIR`). `set -eu`, `curl --fail`, `mkdir -p`. Outputs `JOUST_BINARY=<path>` when install dir isn't on `$PATH` so the skill can capture it.
4. **`.claude/skills/joust/`** — SKILL.md + commands/{draft,pickup,review,status}.md. Every command opens with an install-bootstrap pattern (check version, re-install if out of compat range, run command).

## Adversarial review

Three rounds with Gemini. Outputs at `r1.md` / `r1-gemini.md` / `r2.md` / `r2-gemini.md` / `r3.md`. Round 3 is the final plan; this README executes it.

## Done

- `package.json` gains `"version": "0.2.0"`. Imported into cli.ts via `import pkg from "../package.json" with { type: "json" }`.
- `src/cli.ts`: `--version` / `-v` / `/version` all print `v0.2.0` to stdout. Goes through dispatch like other commands.
- `src/cli.ts`: `--json` flag parsed, threaded to status/export.
- `src/commands.ts::status(dir, { json })`: emits `schema_version: 1` JSON shape with step/actor/action, history counts, configured strategies, declined strategies, best aggregate + tier, scorecards, aggregate_history, pending_summon, draft_chars, critique_count.
- `src/commands.ts::export_draft(dir, { json })`: emits `schema_version: 1` JSON with draft + best aggregate + scorecards + strategies.
- `.github/workflows/release.yml`: build matrix with `ubuntu-latest`/`macos-latest`/`macos-13` for linux-x64/darwin-arm64/darwin-x64. Each build produces `joust-<target>` + `joust-<target>.sha256`. Release job runs only on `v*` tag push; uploads all six artifacts plus `install.sh` to the release.
- `install.sh` (POSIX `sh`, not bash): `set -eu`, detects platform/arch, downloads binary + checksum from the release with `curl --fail`, verifies sha256 (handles both `sha256sum` linux and `shasum -a 256` darwin), atomic mv into `~/.local/bin/joust` (or `$JOUST_INSTALL_DIR`), runs `--version` to verify, emits `JOUST_BINARY=<path>` last-line if install dir not on PATH for agent capture.
- `.claude/skills/joust/`: SKILL.md (hard rules, install bootstrap pattern, routing) + commands/{draft,pickup,review,status}.md. Skill enforces version range (>= 0.2.0 < 1.0.0) and reinstalls if drift. Always uses `--json` for state reads.
- README adds "Claude Code: skill (recommended)" section above the existing slash-command instructions.
- 156 tests pass, binary compiles, syntax-checked install.sh.

## Next

Nothing — ready to merge after review. Post-merge: tag `v0.2.0` to trigger the release workflow, verify all six artifacts + install.sh land on the GitHub Release. Final smoke test: clean machine, `curl | sh`, install joust, run a draft.

## Pitfalls

- **macOS Gatekeeper.** First run of an unsigned binary on macOS triggers a quarantine warning. Document. Real fix is notarization, deferred.
- **Bun cross-compile for darwin from Linux is unreliable.** Plan uses native macOS runners. Don't try to build darwin from Linux.
- **`--json` shape is now a contract.** Once shipped, breaking changes need a major version bump. Plan documents this in SKILL.md and the README.
- **`curl | sh` security.** Sha256 verification is the trust boundary. Sigstore signing is the next level; deferred.
- **Re-install upgrades.** Install script is idempotent — re-running upgrades to latest. Skill enforces compat range and forces re-install if drift.

## Open questions

- Sha256sum on macOS uses a different invocation (`shasum -a 256`); install script must handle both.
- Should `install.sh` accept a target version via env (`JOUST_VERSION=v0.2.0`)? Yes, both for skill compat enforcement and operator pinning.

## Versioning policy

- v0.x: `--json` shape may break with minor bumps.
- v1.0+: `--json` is the public API.
- Skill SKILL.md declares the compat range.
