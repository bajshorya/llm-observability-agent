#!/usr/bin/env bash
#
# Rebuild the Phase 4 golden set.
#
# THE SET IS BUILT IN PAIRS, AND THAT IS THE WHOLE DESIGN
# Each incident is captured twice: once attributed to the commit that really
# caused it, and once to a commit that plainly could not have. The symptoms are
# identical; only the attributed commit differs.
#
# A model that reads the diff answers differently to the two. A model that
# agrees with whatever it was handed answers the same to both and scores 50%.
# Without the pairs, "reads the diff" and "trusts the correlation" are
# indistinguishable — the same trap the correlation set avoids by having four
# declines for four different reasons.
#
# It calls no model. Correlation runs on the stub, because the packet only needs
# an anomaly and a correlation row to exist — the attributed sha is overridden
# per case anyway.
#
#   bash scripts/capture-diagnosis-cases.sh
#
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$REPO/.tmp/capture-diagnosis"
PORT=4950
END_AT="2026-08-16T19:02:00Z"

cd "$REPO" || exit 1
bash "$REPO/scripts/build-fixture-repo.sh" >/dev/null 2>&1

BUG_SHA="$(git -C "$REPO/fixtures/orders-api" log --format=%H --grep='promotional total')"
CI_SHA="$(git -C "$REPO/fixtures/orders-api" log --format=%H --grep='pnpm store')"
DOCS_SHA="$(git -C "$REPO/fixtures/orders-api" log --format=%H --grep='refund window and rate limits')"
LIMITER_SHA="$(git -C "$REPO/fixtures/orders-api" log --format=%H --grep='token bucket')"

seed() {
  local scenario=$1 db="$WORK/$1.db"
  rm -rf "$WORK/$1.db"*; mkdir -p "$WORK"
  sqlite3 "$REPO/data/dev.db" .schema | sqlite3 "$db"

  DATABASE_URL="file:$db" PORT=$PORT pnpm --filter @obs/backend start >/dev/null 2>&1 &
  for _ in $(seq 1 30); do curl -s "localhost:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
  INGEST_URL="http://localhost:$PORT/ingest" \
    pnpm generate backfill --minutes 120 --end-at "$END_AT" >/dev/null 2>&1
  INGEST_URL="http://localhost:$PORT/ingest" \
    pnpm generate inject --scenario "$scenario" --minutes 5 --end-at "$END_AT" >/dev/null 2>&1
  lsof -ti:$PORT | xargs kill -9 >/dev/null 2>&1; sleep 1

  export DATABASE_URL="file:$db"
  pnpm detect >/dev/null 2>&1
  pnpm classify --provider stub >/dev/null 2>&1
  pnpm correlate --provider stub >/dev/null 2>&1
}

capture() {
  local name=$1 scenario=$2 sha=$3 explains=$4 note=$5
  echo ""
  echo "=== $name (expect explains=$explains)"
  pnpm eval --diagnosis --capture "$name" --scenario "$scenario" \
    --sha "$sha" --explains "$explains" --note "$note" 2>&1 \
    | grep -E "Captured|commit |Error|No correlated"
}

# --- the null-price bug ------------------------------------------------------
seed new-error

capture new-error-guilty new-error "$BUG_SHA" yes \
  "The diff adds formatDiscountedPrice, which calls toFixed on a field that is null whenever no promotion applies — exactly the reported error"

capture new-error-ci new-error "$CI_SHA" no \
  "A GitHub Actions workflow file. It does not run in production and cannot throw a TypeError there, whatever the correlation said"

capture new-error-docs new-error "$DOCS_SHA" no \
  "A README change. No executable code, so it cannot produce a runtime failure"

# --- the rate limiter --------------------------------------------------------
seed limiter-misconfig

capture limiter-guilty limiter-misconfig "$LIMITER_SHA" yes \
  "The diff introduces the token bucket running the burst and refill the warning reports, which is what is rejecting legitimate writes"

capture limiter-pricing limiter-misconfig "$BUG_SHA" no \
  "A price-formatting change on the read path. It touches nothing on the write path and cannot cause quota rejections"

unset DATABASE_URL
echo ""
echo "=== captured"
ls -1 "$REPO/packages/backend/src/eval/diagnosis-cases/"
