#!/usr/bin/env bash
#
# Rebuild the golden set from real pipeline runs.
#
# Each case is captured rather than hand-written, so whenever the evidence
# packet changes — a new section, a different sampler, a wider scan — the cases
# have to be rebuilt or the eval scores a prompt the system no longer sends.
# This script is that rebuild.
#
# It never touches data/dev.db. Everything runs against scratch databases under
# .tmp/, seeded once with a healthy baseline and copied per scenario so each
# case starts from identical history.
#
#   bash scripts/capture-cases.sh
#
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$REPO/.tmp/capture"
PORT=4100
BASELINE_MINUTES=120
INJECT_MINUTES=5

cd "$REPO" || exit 1
mkdir -p "$WORK"

start_backend() {
  DATABASE_URL="file:$1" PORT=$PORT pnpm --filter @obs/backend start >/dev/null 2>&1 &
  for _ in $(seq 1 30); do
    curl -s "localhost:$PORT/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "backend failed to start on :$PORT" >&2
  exit 1
}

stop_backend() {
  lsof -ti:$PORT | xargs kill -9 >/dev/null 2>&1
  sleep 1
}

# --- one baseline, reused by every scenario ----------------------------------
if [ ! -f "$WORK/base.db" ]; then
  echo "Seeding baseline ($BASELINE_MINUTES min)..."
  sqlite3 "$REPO/data/dev.db" .schema | sqlite3 "$WORK/base.db"
  start_backend "$WORK/base.db"
  INGEST_URL="http://localhost:$PORT/ingest" \
    pnpm generate backfill --minutes $BASELINE_MINUTES 2>&1 | tail -1
  stop_backend
  sqlite3 "$WORK/base.db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
fi

run_case() {
  local scenario=$1 expect=$2 severity=$3 note=$4
  local db="$WORK/case-$scenario.db"

  echo ""
  echo "=== $scenario ($expect)"
  rm -f "$db" "$db-wal" "$db-shm"
  cp "$WORK/base.db" "$db"

  start_backend "$db"
  INGEST_URL="http://localhost:$PORT/ingest" \
    pnpm generate inject --scenario "$scenario" --minutes $INJECT_MINUTES 2>&1 | tail -1
  stop_backend

  export DATABASE_URL="file:$db"
  pnpm detect 2>&1 | grep -E "orders-api|    -"

  if [ "$(sqlite3 "$db" 'SELECT count(*) FROM anomalies')" = "0" ]; then
    echo "!!! NO ANOMALY — $scenario never reached Tier 2, so it tests nothing"
    unset DATABASE_URL
    return 1
  fi

  pnpm eval --capture "$scenario" --scenario "$scenario" \
    --expect "$expect" --severity "$severity" --note "$note" 2>&1 | grep -E "Captured|expect"
  unset DATABASE_URL
}

# Labels carry their reasoning in --note, so a disagreement is with a stated
# argument rather than a bare boolean.
run_case error-spike incident high \
  "Error rate 40x on known upstream failures; users are getting 5xx across order paths"
run_case latency-jump incident high \
  "p95 degraded ~8x across every endpoint with no errors — all users are affected and nothing says why"
run_case new-error incident critical \
  "A novel TypeError returning 500s on order paths; a code change is failing in production"
run_case deploy-restart benign low \
  "Connection-refused burst confined to a rolling restart, recovered inside the window, latency normal"
run_case batch-job benign low \
  "Aggregate p95 is driven entirely by /internal/reconcile; user endpoints and p50 are unaffected"
run_case rate-limit-storm benign low \
  "One client throttled correctly — 429s are the protection working, nothing else degraded"

echo ""
echo "=== captured"
ls -1 "$REPO/packages/backend/src/eval/cases/"
