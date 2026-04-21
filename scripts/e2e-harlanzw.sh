#!/usr/bin/env bash
# One-off end-to-end test against real GSC API.
# Dumps harlanzw.com (or $SITE), then exercises every local analyzer with
# varied dimensions, filters, date ranges, and output formats. Outputs land
# in $OUT_DIR (default: tmp/e2e-harlanzw/).
#
# Prereqs: run `pnpm dlx @gscdump/cli init` once to set up auth, or ensure
# `~/.config/gscdump/config.json` + credentials are already in place.
#
# Usage:
#   scripts/e2e-harlanzw.sh
#   SITE=sc-domain:example.com DAYS=30 scripts/e2e-harlanzw.sh

set -u

SITE="${SITE:-sc-domain:harlanzw.com}"
DAYS="${DAYS:-60}"
OUT_DIR="${OUT_DIR:-tmp/e2e-harlanzw}"
CLI="node packages/cli/dist/index.mjs"

cd "$(dirname "$0")/.."
mkdir -p "$OUT_DIR"

today_minus() {
  node -e "console.log(new Date(Date.now() - $1 * 86400000).toISOString().split('T')[0])"
}

CUR_START=$(today_minus 10)
CUR_END=$(today_minus 4)
PREV_START=$(today_minus 17)
PREV_END=$(today_minus 11)
MONTH_START=$(today_minus 35)
MONTH_END=$(today_minus 5)

log()  { printf '\n\033[1;34m[e2e]\033[0m %s\n' "$*"; }
step() { printf '\n\033[1;36m→ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }

PASS=0
FAIL=0
FAILED_CMDS=()

run_cmd() {
  local label="$1"; shift
  step "$label"
  printf '  $ %s\n' "$*"
  if "$@"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILED_CMDS+=("$label")
    warn "command failed: $label"
  fi
}

run_analysis() {
  local tool="$1"; shift
  local label="analyze $tool $*"
  local safe_name="${tool}_$(printf '%s' "$*" | tr -s ' /=' '_')"
  local txt_out="$OUT_DIR/${safe_name}.txt"
  local json_out="$OUT_DIR/${safe_name}.json"
  step "$label"
  printf '  $ %s\n' "$CLI analyze $tool --site $SITE $* --format table"
  if $CLI analyze "$tool" --site "$SITE" "$@" --format table > "$txt_out" 2>&1; then
    head -20 "$txt_out"
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILED_CMDS+=("$label")
    warn "failed (see $txt_out)"
    head -10 "$txt_out"
  fi
  $CLI analyze "$tool" --site "$SITE" "$@" --json > "$json_out" 2>&1 || true
}

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

log "Building packages..."
pnpm build > "$OUT_DIR/_build.log" 2>&1 || {
  warn "build failed — see $OUT_DIR/_build.log"
  exit 1
}

# ---------------------------------------------------------------------------
# Auth sanity check
# ---------------------------------------------------------------------------

log "Verifying sites access (auth sanity check)..."
if ! $CLI sites > "$OUT_DIR/_sites.txt" 2>&1; then
  warn "sites command failed. Authenticate first:"
  warn "  $CLI init"
  cat "$OUT_DIR/_sites.txt"
  exit 1
fi
head -30 "$OUT_DIR/_sites.txt"

# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------

log "Syncing $SITE for last $DAYS days across all 5 tables (pages, keywords, countries, devices, page_keywords)..."
run_cmd "sync $DAYS days (all tables)" \
  $CLI sync --site "$SITE" --days "$DAYS" \
    --tables pages,keywords,countries,devices,page_keywords

log "Local store stats after sync:"
$CLI store stats | tee "$OUT_DIR/_stats.txt"

# ---------------------------------------------------------------------------
# Single-period analyzers
# ---------------------------------------------------------------------------

log "=== Single-period analyzers ==="

run_analysis striking-distance
run_analysis striking-distance --start "$MONTH_START" --end "$MONTH_END" --limit 50

run_analysis opportunity
run_analysis opportunity --start "$MONTH_START" --end "$MONTH_END" --limit 30

run_analysis brand --brand-terms "harlan,harlanzw,zhang"

run_analysis clustering
run_analysis clustering --cluster-by intent --limit 50
run_analysis clustering --cluster-by prefix --limit 50

run_analysis concentration
run_analysis concentration --dimension keywords

run_analysis seasonality
run_analysis seasonality --metric impressions

# ---------------------------------------------------------------------------
# Comparison analyzers
# ---------------------------------------------------------------------------

log "=== Comparison analyzers (current $CUR_START→$CUR_END vs previous $PREV_START→$PREV_END) ==="

run_analysis movers \
  --start "$CUR_START" --end "$CUR_END" \
  --prev-start "$PREV_START" --prev-end "$PREV_END"

run_analysis decay \
  --start "$CUR_START" --end "$CUR_END" \
  --prev-start "$PREV_START" --prev-end "$PREV_END"

# ---------------------------------------------------------------------------
# Output format variety
# ---------------------------------------------------------------------------

log "=== Format variety ==="

step "striking-distance → CSV"
$CLI analyzestriking-distance --site "$SITE" --format csv --limit 25 \
  > "$OUT_DIR/striking-distance.csv" 2>&1 \
  && { head -6 "$OUT_DIR/striking-distance.csv"; PASS=$((PASS + 1)); } \
  || { warn "CSV output failed"; FAIL=$((FAIL + 1)); FAILED_CMDS+=("CSV output"); }

step "opportunity → JSON (pretty)"
$CLI analyzeopportunity --site "$SITE" --json --limit 10 \
  > "$OUT_DIR/opportunity-pretty.json" 2>&1 \
  && { head -40 "$OUT_DIR/opportunity-pretty.json"; PASS=$((PASS + 1)); } \
  || { warn "JSON output failed"; FAIL=$((FAIL + 1)); FAILED_CMDS+=("JSON output"); }

# ---------------------------------------------------------------------------
# Cloud-only tools (expected to error or fall back)
# ---------------------------------------------------------------------------

log "=== Cloud-only tools (expected: fall back to live API, which rejects for local mode) ==="

run_analysis cannibalization
run_analysis zero-click

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

log "=== Summary ==="
printf '  Passed: %d\n' "$PASS"
printf '  Failed: %d\n' "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '\n  Failed commands:\n'
  for c in "${FAILED_CMDS[@]}"; do
    printf '    - %s\n' "$c"
  done
fi
printf '\n  Outputs: %s/\n' "$OUT_DIR"
ls -la "$OUT_DIR/" | tail -n +2

exit "$FAIL"
