#!/usr/bin/env bash
#
# run all 3 demos as a smoke test suite.
# each demo exercises a different joust capability.
#
# usage:
#   ./demo/run-all.sh          # run all
#   ./demo/run-all.sh 1        # run just demo 1
#   ./demo/run-all.sh 2        # run just demo 2
#   ./demo/run-all.sh 3        # run just demo 3
#
set -e
cd "$(dirname "$0")/.."

JOUST="bun run src/cli.ts"
DEMO_DIR="demo/output"
PASSED=0
FAILED=0
WHICH="${1:-all}"

rm -rf "$DEMO_DIR"
mkdir -p "$DEMO_DIR"

pass() { echo "  PASS: $1"; PASSED=$((PASSED + 1)); }
fail() { echo "  FAIL: $1"; FAILED=$((FAILED + 1)); }

# -----------------------------------------------------------------------
# demo 1: basic init + run (the happy path)
#
# exercises: phase 0 bootstrap, accumulator loop, linting, atomic writes,
#            NNN-slug.json history, snowball.json bomber copy, STDOUT output
# -----------------------------------------------------------------------
demo_1() {
  echo ""
  echo "=== demo 1: basic init + run ==="
  echo ""

  local DIR="$DEMO_DIR/demo-1"

  # init
  $JOUST init "design a webhook delivery system that guarantees at-least-once delivery" 2>"$DEMO_DIR/demo-1-init.log"

  # the slug dir gets created in cwd — find it
  local SLUG_DIR
  SLUG_DIR=$(ls -d design-a-webhook-delivery-system-* 2>/dev/null | head -1)
  if [ -z "$SLUG_DIR" ]; then
    fail "init did not create state directory"
    return
  fi
  mv "$SLUG_DIR" "$DIR"
  pass "init created state directory"

  # check directory structure
  [ -f "$DIR/rfc.yaml" ]        && pass "rfc.yaml exists"        || fail "rfc.yaml missing"
  [ -f "$DIR/snowball.json" ]   && pass "snowball.json exists"   || fail "snowball.json missing"
  [ -d "$DIR/history" ]         && pass "history/ exists"        || fail "history/ missing"
  [ -d "$DIR/logs" ]            && pass "logs/ exists"           || fail "logs/ missing"
  [ -f "$DIR/history/000-main.json" ] && pass "000-main.json seed exists" || fail "seed missing"

  # check snowball has invariants
  local MUST_COUNT
  MUST_COUNT=$(bun -e "const s = await Bun.file('$DIR/snowball.json').json(); console.log(s.invariants.MUST.length)")
  [ "$MUST_COUNT" -gt 0 ] && pass "snowball has $MUST_COUNT MUST invariants" || fail "no MUST invariants"

  # run 1 round
  local FINAL_MD="$DEMO_DIR/demo-1-output.md"
  $JOUST run "$DIR" 2>"$DEMO_DIR/demo-1-run.log" > "$FINAL_MD"

  # check history grew
  local HISTORY_COUNT
  HISTORY_COUNT=$(ls "$DIR/history/"*.json 2>/dev/null | wc -l)
  [ "$HISTORY_COUNT" -gt 1 ] && pass "history has $HISTORY_COUNT entries" || fail "history did not grow"

  # check STDOUT produced markdown
  [ -s "$FINAL_MD" ] && pass "STDOUT produced markdown ($(wc -c < "$FINAL_MD") bytes)" || fail "no STDOUT output"

  # check atomic write safety: no .tmp files left
  local TMP_COUNT
  TMP_COUNT=$(ls "$DIR/history/"*.tmp "$DIR/"*.tmp 2>/dev/null | wc -l)
  [ "$TMP_COUNT" -eq 0 ] && pass "no orphaned .tmp files" || fail "$TMP_COUNT orphaned .tmp files"

  echo ""
  echo "  demo 1 output: $FINAL_MD"
}

# -----------------------------------------------------------------------
# demo 2: resume after interrupt
#
# exercises: implicit resume, crash recovery, state directory portability,
#            config re-read at round boundary
# -----------------------------------------------------------------------
demo_2() {
  echo ""
  echo "=== demo 2: resume after interrupt ==="
  echo ""

  local DIR="$DEMO_DIR/demo-2"

  # init
  $JOUST init "design an event sourcing system for an e-commerce order pipeline" 2>"$DEMO_DIR/demo-2-init.log"

  local SLUG_DIR
  SLUG_DIR=$(ls -d design-an-event-sourcing-system-* 2>/dev/null | head -1)
  if [ -z "$SLUG_DIR" ]; then
    fail "init did not create state directory"
    return
  fi
  mv "$SLUG_DIR" "$DIR"
  pass "init created state directory"

  # override config to only run 1 round so first run is quick
  cat > "$DIR/rfc.yaml" <<'YAML'
defaults:
  temperature: 0.2
  max_retries: 2
  compaction_threshold: 10
  max_rounds: 1

agents:
  main:
    model: claude-opus-4-6
    api_key: $ANTHROPIC_API_KEY
    system: >
      You are the lead architect. Define and enforce strict RFC 2119 invariants.
  security:
    model: gemini-2.5-pro
    api_key: $GEMINI_API_KEY
    system: >
      You are a security auditor. Find vulnerabilities.
YAML
  pass "wrote custom rfc.yaml (1 round, 1 jouster)"

  # first run: 1 round
  $JOUST run "$DIR" 2>"$DEMO_DIR/demo-2-run1.log" > /dev/null

  local COUNT_AFTER_RUN1
  COUNT_AFTER_RUN1=$(ls "$DIR/history/"*.json 2>/dev/null | wc -l)
  pass "first run produced $COUNT_AFTER_RUN1 history entries"

  # now update config for 1 more round and resume
  cat > "$DIR/rfc.yaml" <<'YAML'
defaults:
  temperature: 0.2
  max_retries: 2
  compaction_threshold: 10
  max_rounds: 1

agents:
  main:
    model: claude-opus-4-6
    api_key: $ANTHROPIC_API_KEY
    system: >
      You are the lead architect. Define and enforce strict RFC 2119 invariants.
  cfo:
    model: claude-sonnet-4-6
    api_key: $ANTHROPIC_API_KEY
    system: >
      You are the CFO. Optimize for cost.
YAML
  pass "swapped security for cfo in config"

  # second run: resumes from where we left off, now with cfo
  local FINAL_MD="$DEMO_DIR/demo-2-output.md"
  $JOUST run "$DIR" 2>"$DEMO_DIR/demo-2-run2.log" > "$FINAL_MD"

  local COUNT_AFTER_RUN2
  COUNT_AFTER_RUN2=$(ls "$DIR/history/"*.json 2>/dev/null | wc -l)
  [ "$COUNT_AFTER_RUN2" -gt "$COUNT_AFTER_RUN1" ] && pass "resume grew history ($COUNT_AFTER_RUN1 -> $COUNT_AFTER_RUN2)" || fail "resume did not grow history"

  # check that cfo participated (look for cfo slug in filenames)
  ls "$DIR/history/"*-cfo.json >/dev/null 2>&1 && pass "cfo appears in history after config swap" || fail "cfo not in history"

  # check STDOUT
  [ -s "$FINAL_MD" ] && pass "STDOUT produced markdown ($(wc -c < "$FINAL_MD") bytes)" || fail "no STDOUT output"

  echo ""
  echo "  demo 2 output: $FINAL_MD"
}

# -----------------------------------------------------------------------
# demo 3: draft (one-shot) with --tank
#
# exercises: joust draft end-to-end, --tank flag (error resilience),
#            $EDITOR-less operation, piping STDOUT
# -----------------------------------------------------------------------
demo_3() {
  echo ""
  echo "=== demo 3: draft with --tank ==="
  echo ""

  local FINAL_MD="$DEMO_DIR/demo-3-output.md"

  # draft runs init + run in one shot
  # --tank means it won't crash on transient errors
  $JOUST draft "design a rate limiter for a multi-tenant saas api using token bucket with redis" --tank 2>"$DEMO_DIR/demo-3.log" > "$FINAL_MD"

  # find the state dir it created
  local SLUG_DIR
  SLUG_DIR=$(ls -d design-a-rate-limiter-* 2>/dev/null | head -1)
  if [ -z "$SLUG_DIR" ]; then
    fail "draft did not create state directory"
    return
  fi
  mv "$SLUG_DIR" "$DEMO_DIR/demo-3"
  pass "draft created state directory"

  local DIR="$DEMO_DIR/demo-3"

  # check history
  local HISTORY_COUNT
  HISTORY_COUNT=$(ls "$DIR/history/"*.json 2>/dev/null | wc -l)
  [ "$HISTORY_COUNT" -gt 3 ] && pass "history has $HISTORY_COUNT entries (seed + jousters + polish)" || fail "history too short ($HISTORY_COUNT)"

  # check STDOUT
  [ -s "$FINAL_MD" ] && pass "STDOUT produced markdown ($(wc -c < "$FINAL_MD") bytes)" || fail "no STDOUT output"

  # check logs were written
  local LOG_COUNT
  LOG_COUNT=$(ls "$DIR/logs/"*.log 2>/dev/null | wc -l)
  [ "$LOG_COUNT" -gt 0 ] && pass "logs/ has $LOG_COUNT files" || fail "no log files"

  # verify the final markdown is actually about rate limiting (sanity)
  grep -qi "rate.limit\|token.bucket\|redis" "$FINAL_MD" && pass "output is on-topic (rate limiter)" || fail "output seems off-topic"

  echo ""
  echo "  demo 3 output: $FINAL_MD"
}

# -----------------------------------------------------------------------
# run
# -----------------------------------------------------------------------
echo "joust demo suite"
echo "================"

case "$WHICH" in
  1)   demo_1 ;;
  2)   demo_2 ;;
  3)   demo_3 ;;
  all) demo_1; demo_2; demo_3 ;;
  *)   echo "usage: $0 [1|2|3|all]"; exit 1 ;;
esac

echo ""
echo "================"
echo "passed: $PASSED"
echo "failed: $FAILED"
echo ""

[ "$FAILED" -eq 0 ] && echo "all demos passed." || { echo "SOME DEMOS FAILED."; exit 1; }
