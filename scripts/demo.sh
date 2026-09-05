#!/usr/bin/env bash
#
# The whole pipeline, in one command.
#
#   bash scripts/demo.sh                  # free, offline, no API key
#   bash scripts/demo.sh gemini           # with a real model
#   bash scripts/demo.sh gemini deploy-restart   # a benign window instead
#
# WHY THIS EXISTS
# Seeing this system work took ten commands across two terminals, and that
# count assumes you already knew the eleventh thing, which was written down
# nowhere: the fixture repository has to overlap the generated traffic in time,
# or correlation finds zero candidates and the most interesting stage does
# nothing. That trap caught the author twice.
#
# This script removes both problems. It pins traffic and fixture to the same
# instant, runs every stage in order, and prints what each one concluded.
#
# IT DOES NOT TOUCH data/dev.db
# Everything lands in a scratch database under .tmp/, printed at the end so you
# can point the dashboard at it. A demo that overwrites your working database
# is a demo you run once and then avoid.
#
# IT DEFAULTS TO THE STUB, AND SAYS SO
# With no argument every stage runs offline against the deterministic stub: no
# API key, no network, no quota. The stub is not a mock — it is the baseline
# each tier has to beat, so the output is a fair picture of what the STATISTICS
# alone conclude. Pass a provider to see what a model adds.
#
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$REPO/.tmp/demo"
DB="$WORK/demo.db"
PORT=4900
PROVIDER="${1:-stub}"
SCENARIO="${2:-new-error}"

# Traffic and fixture are pinned to the same instant, two minutes apart, so the
# buggy deploy lands just before the anomaly window and the 48-hour lookback
# offers a full set of candidates. This is the alignment the trap was about.
END_AT="2026-08-16T19:02:00Z"
BASELINE_MINUTES=120
INJECT_MINUTES=5

cd "$REPO" || exit 1

step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
note() { printf '   %s\n' "$1"; }

cleanup() { lsof -ti:$PORT | xargs kill -9 >/dev/null 2>&1; }
trap cleanup EXIT

# --- 0. preflight ------------------------------------------------------------
if [ ! -f "$REPO/data/dev.db" ]; then
  step "Creating the schema (data/dev.db does not exist yet)"
  pnpm db:push >/dev/null 2>&1 || { echo "db:push failed"; exit 1; }
fi

step "Building the target repository the correlator reads"
bash "$REPO/scripts/build-fixture-repo.sh" >/dev/null 2>&1
note "12 commits at a pinned anchor, so the shas are the same on every machine"

rm -rf "$WORK"; mkdir -p "$WORK"
sqlite3 "$REPO/data/dev.db" .schema | sqlite3 "$DB"
note "scratch database: $DB (data/dev.db is untouched)"

# --- 1. traffic --------------------------------------------------------------
step "Generating traffic"
DATABASE_URL="file:$DB" PORT=$PORT pnpm --filter @obs/backend start >"$WORK/backend.log" 2>&1 &
for _ in $(seq 1 30); do
  curl -s "localhost:$PORT/health" >/dev/null 2>&1 && break
  sleep 1
done

INGEST_URL="http://localhost:$PORT/ingest" \
  pnpm generate backfill --minutes $BASELINE_MINUTES --end-at "$END_AT" 2>&1 | tail -1
INGEST_URL="http://localhost:$PORT/ingest" \
  pnpm generate inject --scenario "$SCENARIO" --minutes $INJECT_MINUTES --end-at "$END_AT" 2>&1 | tail -1
cleanup; sleep 1

export DATABASE_URL="file:$DB"

# --- 2. Tier 1 ---------------------------------------------------------------
step "Tier 1 — statistical detection (no model, no cost)"
pnpm detect 2>&1 | grep -E "orders-api|    -|clean" || note "no anomaly detected"

if [ "$(sqlite3 "$DB" 'SELECT count(*) FROM anomalies')" = "0" ]; then
  note "Nothing tripped the detectors, so there is nothing for the later stages to read."
  exit 0
fi

# --- 3. Tier 2 ---------------------------------------------------------------
step "Tier 2 — is it a real incident? ($PROVIDER)"
pnpm classify --provider "$PROVIDER" 2>&1 | grep -E "orders-api:|^    " | head -6

# --- 4. Phase 3 --------------------------------------------------------------
step "Phase 3 — which commit explains it? ($PROVIDER)"
pnpm correlate --provider "$PROVIDER" 2>&1 | grep -E "orders-api|^    " | head -6

# --- 5. Phase 4 --------------------------------------------------------------
step "Phase 4 — why did it break, and what should change? ($PROVIDER)"
pnpm diagnose --provider "$PROVIDER" 2>&1 | grep -E "orders-api|^    " | head -6

# --- 6. what it cost ---------------------------------------------------------
step "The funnel, which is the argument the design is made from"
pnpm classify --stats 2>&1 | grep -E "anomalies ->" | sed 's/^ */   /'
pnpm correlate --stats 2>&1 | grep -E "incident" | sed 's/^ */   /'
pnpm diagnose --stats 2>&1 | grep -E "attributed|applied" | sed 's/^ */   /'

step "See it in a browser"
note "DATABASE_URL=\"file:$DB\" pnpm dashboard"
note "then open http://localhost:3000"

if [ "$PROVIDER" = "stub" ]; then
  step "That was the baseline, not a model"
  note "Every stage above ran offline against the deterministic stub, which is"
  note "the thing each tier has to beat rather than a mock of it. To see what a"
  note "model adds, set a key in .env and run:"
  note ""
  note "   bash scripts/demo.sh gemini"
fi
