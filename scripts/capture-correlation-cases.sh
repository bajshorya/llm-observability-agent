#!/usr/bin/env bash
#
# Rebuild the correlation golden set from real pipeline runs.
#
# Like scripts/capture-cases.sh, each case is CAPTURED rather than written by
# hand, so the stored prompt is exactly what some real run produced. When the
# correlation packet changes, the cases have to be rebuilt or the eval scores a
# prompt the system no longer sends.
#
# WHAT IS DIFFERENT FROM THE CLASSIFIER CAPTURE
#
# 1. IT CALLS NO MODEL AT ALL. A correlation packet embeds Tier 2's verdict, and
#    re-deriving that from a model on every capture is what made the set's
#    difficulty drift between generations — one case failed on three models in
#    one capture and passed on two in the next, with no packet change. The
#    verdict is now pinned in src/eval/verdicts/ and read from there, so a
#    re-capture is comparable to the capture before it.
#
#    The pinned verdicts are real Tier 2 output, recorded rather than redrawn.
#
# 2. IT REBUILDS THE FIXTURE WITH --anchor now. The fixture's pinned anchor sits
#    on the date the classifier cases were captured; traffic generated today
#    would leave it outside the 48-hour lookback and every packet would say "no
#    candidates". Anchoring to now gives different shas each run — which is
#    harmless here, because a correlation case stores its prompt AND its
#    expected sha together and is therefore self-contained. It does mean the
#    fixture is left anchored to now; rebuild with no flag to restore.
#
# 3. THE LABELS INCLUDE A SHA, AND IT IS CHECKED. `--sha` is resolved against
#    the candidates in the packet being captured, and capture fails if it
#    matches none. A case expecting a commit its own evidence does not contain
#    would score every model wrong forever and look like a model problem.
#
#   bash scripts/capture-correlation-cases.sh
#
#   CAPTURE_CONTROL=1 bash scripts/capture-correlation-cases.sh gemini
#     also stores a with-hunks arm per scenario as diff-<scenario>, captured
#     from the SAME anomaly, so the two differ only in the hunks.
#
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$REPO/.tmp/capture-correlation"
PORT=4300
BASELINE_MINUTES=120
INJECT_MINUTES=5
# Set to 1 to also capture a WITH-HUNKS arm per scenario, named diff-<scenario>,
# for measuring what the hunks are worth. Hunks are off in the shipped packet;
# see DOCUMENTATION-EVALS.md §14 for the A/B that decided that.
CAPTURE_CONTROL="${CAPTURE_CONTROL:-0}"

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

# --- the fixture has to overlap traffic generated now ------------------------
echo "Rebuilding the fixture anchored to now..."
bash "$REPO/scripts/build-fixture-repo.sh" --anchor now >/dev/null 2>&1

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
  local scenario=$1 sha=$2 files=$3 note=$4
  local db="$WORK/case-$scenario.db"

  echo ""
  echo "=== $scenario (expect ${sha})"
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

  # No classification call. The verdict comes from src/eval/verdicts/, pinned,
  # because re-deriving it from a model on every capture is what made the set's
  # difficulty drift between generations. See src/eval/verdicts.ts.

  local args=(--correlation --capture "$scenario" --scenario "$scenario" --sha "$sha" --note "$note")
  [ -n "$files" ] && args+=(--files "$files")

  pnpm eval "${args[@]}" 2>&1 | grep -E "Captured|expect|matches none"

  # The control arm, from the SAME anomaly: identical traffic, identical
  # classifier summary, identical candidate commits — only the hunks differ.
  # Capturing it from a separate run would confound the diff with everything
  # else that differed between two runs.
  if [ "$CAPTURE_CONTROL" = "1" ]; then
    # Built fresh rather than substituted into the array above: `--capture` and
    # its value are separate elements, so a pattern spanning both never matches
    # and the control would silently overwrite the case it is meant to control.
    local control=(--correlation --capture "diff-$scenario" --scenario "$scenario" \
                   --sha "$sha" --note "$note" --diff)
    [ -n "$files" ] && control+=(--files "$files")

    pnpm eval "${control[@]}" 2>&1 | grep -E "Captured|matches none"
  fi

  unset DATABASE_URL
}

# Labels carry their reasoning in --note, so a disagreement is with a stated
# argument rather than a bare sha.
#
# NOTE ON `orphan-refund-bug`: its null label is true at the DEFAULT 48-hour
# lookback, which is what excludes the commit that really caused it. Capture it
# with a wider --lookback and the label becomes wrong rather than hard.
#
# The two attributable cases point at DIFFERENT commits on purpose. With one,
# "finds the guilty commit" and "has learned the answer is the pricing one"
# score identically.

BUG_SHA="$(git -C "$REPO/fixtures/orders-api" log --format=%H --grep='promotional total')"
LIMITER_SHA="$(git -C "$REPO/fixtures/orders-api" log --format=%H --grep='token bucket')"

run_case new-error "$BUG_SHA" "src/lib/pricing.js" \
  "The novel TypeError is a null dereference on toFixed; this commit added a call to it on a field that is null whenever no promotion applies"

run_case limiter-misconfig "$LIMITER_SHA" "src/middleware/rateLimit.js" \
  "Legitimate writes rejected at quota across hundreds of clients; this commit introduced the token bucket running the burst and refill the warning reports"

run_case error-spike none "" \
  "40x volume of failures that already exist in the baseline — an upstream or load problem, not a code change; no candidate commit touches the payments path"

run_case latency-jump none "" \
  "p95 degraded across every endpoint with no new error signature and no commit touching a latency-sensitive path; nothing in the diff explains it"

# The decline half is deliberately three DIFFERENT reasons to answer null. Two
# cases that both mean "upstream is failing" measure one thing twice.
run_case traffic-surge none "" \
  "Volume 5x baseline saturating a pool sized in the initial scaffold; the load changed and the code did not, and no commit in the window touches capacity"

run_case orphan-refund-bug none "" \
  "A novel error, which is the strongest signal that code changed — but the change is nine days old and outside the lookback. No candidate touches src/routes/refunds.js, so the honest answer is that none of them explains it"

echo ""
echo "=== captured"
ls -1 "$REPO/packages/backend/src/eval/correlation-cases/"
echo ""
echo "The fixture is left anchored to now. Restore the pinned shas with:"
echo "  bash scripts/build-fixture-repo.sh"
