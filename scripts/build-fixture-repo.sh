#!/usr/bin/env bash
#
# Build the target repository that Phase 3 correlates against.
#
# WHY THIS EXISTS
# The correlation agent answers "which recent commit most likely caused this
# anomaly?". To evaluate that honestly it needs a real git history: real shas,
# real timestamps, real `git log --numstat` output. Phase 1 and 2 are credible
# because the benign scenarios force the classifier to say NO; the equivalent
# discipline here is that the history must contain commits that are plausible
# and wrong, not one obviously guilty commit in an otherwise empty log.
#
# So the history below is built to defeat three cheap heuristics:
#
#   "pick the most recent commit"   The bug is not last. Two commits land
#                                   after it.
#   "pick the commit whose files
#    sound relevant"                Three separate commits touch pricing.ts.
#                                   Only one of them is the bug.
#   "always name something"         The rate-limit and batch scenarios have a
#                                   tempting candidate (the token-bucket
#                                   commit) and the correct answer is still
#                                   null. `correlationSchema.suspectedCommitSha`
#                                   is nullable for exactly this.
#
# WHY GENERATED RATHER THAN COMMITTED
# A git repository nested inside this one is awkward to review and easy to
# corrupt. Instead this script regenerates it, and every commit's author date,
# committer date, author identity and message are pinned — so the resulting
# shas are byte-identical on every machine, every run. The history is a
# deterministic function of this file. Diff this script and you have diffed the
# fixture.
#
#   bash scripts/build-fixture-repo.sh            # pinned anchor, stable shas
#   bash scripts/build-fixture-repo.sh --anchor now   # anchored to now, for a
#                                                     # live demo; shas differ
#
# The pinned anchor is the default because golden cases reference shas. Use
# --anchor now only for demos that are never compared against a stored file.
#
set -eu

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$REPO/fixtures/orders-api"

# The moment the buggy deploy goes out. Everything else is expressed relative
# to it. Pinned so shas are reproducible; see --anchor above.
# It is pinned to 19:00Z on the day the golden cases were captured, so the
# buggy deploy lands 95 minutes before their 18:57-19:02 window rather than a
# year adrift of it.
ANCHOR_EPOCH=1786906800   # 2026-08-16T19:00:00Z

if [ "${1:-}" = "--anchor" ] && [ "${2:-}" = "now" ]; then
  ANCHOR_EPOCH="$(date +%s)"
  echo "Anchoring to now ($ANCHOR_EPOCH) — shas will not match the golden cases."
fi

# BSD date (macOS) and GNU date disagree on every flag that matters here, so
# offsets are computed as plain integer arithmetic and formatted once.
at() { # at <seconds-before-anchor> -> ISO 8601 UTC
  local when=$(( ANCHOR_EPOCH - $1 ))
  if date -u -r 0 >/dev/null 2>&1; then
    date -u -r "$when" +"%Y-%m-%dT%H:%M:%S+00:00"   # BSD
  else
    date -u -d "@$when" +"%Y-%m-%dT%H:%M:%S+00:00"  # GNU
  fi
}

MIN=60; HOUR=3600; DAY=86400

rm -rf "$OUT"
mkdir -p "$OUT"
cd "$OUT"

git init -q -b main
git config user.name "orders-api ci"
git config user.email "ci@orders-api.internal"
git config commit.gpgsign false

commit() { # commit <seconds-before-anchor> <subject> [body]
  local when; when="$(at "$1")"; shift
  local subject="$1"; shift
  git add -A
  GIT_AUTHOR_DATE="$when" GIT_COMMITTER_DATE="$when" \
    git commit -q -m "$subject" ${1+-m "$1"}
}

# --- T-9d  scaffold ----------------------------------------------------------
mkdir -p src/routes src/lib src/middleware test

cat > package.json <<'EOF'
{
  "name": "orders-api",
  "version": "1.0.0",
  "private": true,
  "main": "src/server.js",
  "dependencies": {
    "express": "4.18.2"
  }
}
EOF

cat > src/server.js <<'EOF'
const express = require("express");
const orders = require("./routes/orders");

const app = express();
app.use(express.json());
app.use("/orders", orders);

app.get("/health", (_req, res) => res.json({ ok: true }));

module.exports = app;
EOF

cat > src/lib/db.js <<'EOF'
// Thin wrapper over the orders table. Nothing clever on purpose.
const pool = require("./pool");

async function listOrders({ limit = 50 } = {}) {
  return pool.query("SELECT * FROM orders ORDER BY created_at DESC LIMIT $1", [limit]);
}

async function getOrder(id) {
  const rows = await pool.query("SELECT * FROM orders WHERE id = $1", [id]);
  return rows[0] ?? null;
}

module.exports = { listOrders, getOrder };
EOF

cat > src/lib/pool.js <<'EOF'
// Connection pool. Sized to 20; the nightly reconciliation job shares it.
module.exports = { query: async () => [] };
EOF

cat > src/routes/orders.js <<'EOF'
const { Router } = require("express");
const db = require("../lib/db");

const router = Router();

router.get("/", async (_req, res) => {
  const orders = await db.listOrders();
  res.json({ orders });
});

module.exports = router;
EOF

commit $(( 9 * DAY )) "chore: initial orders-api scaffold" \
"Express app, a pool wrapper and the order list route. The pool is
deliberately sized at 20 to match production."

# --- T-8d  GET /orders/:id ---------------------------------------------------
cat > src/routes/orders.js <<'EOF'
const { Router } = require("express");
const db = require("../lib/db");

const router = Router();

router.get("/", async (_req, res) => {
  const orders = await db.listOrders();
  res.json({ orders });
});

router.get("/:id", async (req, res) => {
  const order = await db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "not found" });
  res.json({ order });
});

module.exports = router;
EOF

commit $(( 8 * DAY )) "feat(orders): add GET /orders/:id" \
"Single-order lookup. 404s rather than returning null so the client does
not have to distinguish an empty body from a missing order."

# --- T-7d  refunds -----------------------------------------------------------
cat > src/routes/refunds.js <<'EOF'
const { Router } = require("express");
const db = require("../lib/db");

const router = Router({ mergeParams: true });

// Refunds are allowed for 30 days after the order is placed.
const REFUND_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

router.post("/", async (req, res) => {
  const order = await db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "not found" });

  if (Date.now() - order.created_at > REFUND_WINDOW_MS) {
    return res.status(422).json({ error: "refund window has closed" });
  }

  res.status(201).json({ refunded: true, orderId: order.id });
});

module.exports = router;
EOF

cat > src/server.js <<'EOF'
const express = require("express");
const orders = require("./routes/orders");
const refunds = require("./routes/refunds");

const app = express();
app.use(express.json());
app.use("/orders", orders);
app.use("/orders/:id/refund", refunds);

app.get("/health", (_req, res) => res.json({ ok: true }));

module.exports = app;
EOF

commit $(( 7 * DAY )) "feat(refunds): add POST /orders/:id/refund" \
"Refunds inside a 30-day window. Out-of-window requests are a 422 rather
than a 400 — the request is well formed, the state is wrong."

# --- T-5d  tests -------------------------------------------------------------
cat > test/orders.test.js <<'EOF'
const request = require("supertest");
const app = require("../src/server");

test("GET /orders returns a list", async () => {
  const res = await request(app).get("/orders");
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.orders)).toBe(true);
});

test("GET /orders/:id 404s for an unknown order", async () => {
  const res = await request(app).get("/orders/does-not-exist");
  expect(res.status).toBe(404);
});
EOF

commit $(( 5 * DAY )) "test: cover the order list and detail routes"

# --- T-4d  index -------------------------------------------------------------
mkdir -p migrations
cat > migrations/002_orders_created_at_idx.sql <<'EOF'
-- The list route sorts by created_at on every request and was doing a
-- sequential scan over ~4M rows.
CREATE INDEX CONCURRENTLY orders_created_at_idx ON orders (created_at DESC);
EOF

commit $(( 4 * DAY )) "perf(db): index orders.created_at" \
"The list route sorts by created_at on every request. CONCURRENTLY so the
migration does not take a write lock on a hot table."

# --- T-3d  dependency bump ---------------------------------------------------
cat > package.json <<'EOF'
{
  "name": "orders-api",
  "version": "1.0.0",
  "private": true,
  "main": "src/server.js",
  "dependencies": {
    "express": "4.19.2"
  }
}
EOF

commit $(( 3 * DAY )) "chore(deps): bump express to 4.19.2" \
"Picks up the fix for CVE-2024-29041. No API changes."

# --- T-34h  rate limiter — DECOY for rate-limit-storm ------------------------
cat > src/middleware/rateLimit.js <<'EOF'
// Per-client token bucket on write paths. A client that outruns its bucket
// gets a 429 and is told when to retry; rejecting is cheap by design.
const CAPACITY = 120;          // requests
const REFILL_PER_SEC = 2;

const buckets = new Map();

function rateLimit(req, res, next) {
  const clientId = req.get("x-client-id") ?? "anonymous";
  const now = Date.now();
  const bucket = buckets.get(clientId) ?? { tokens: CAPACITY, updatedAt: now };

  const refill = ((now - bucket.updatedAt) / 1000) * REFILL_PER_SEC;
  bucket.tokens = Math.min(CAPACITY, bucket.tokens + refill);
  bucket.updatedAt = now;

  if (bucket.tokens < 1) {
    buckets.set(clientId, bucket);
    res.set("retry-after", "1");
    return res.status(429).json({ error: `Rate limit exceeded for client ${clientId}` });
  }

  bucket.tokens -= 1;
  buckets.set(clientId, bucket);
  next();
}

module.exports = { rateLimit };
EOF

cat > src/server.js <<'EOF'
const express = require("express");
const orders = require("./routes/orders");
const refunds = require("./routes/refunds");
const { rateLimit } = require("./middleware/rateLimit");

const app = express();
app.use(express.json());
app.use(rateLimit);
app.use("/orders", orders);
app.use("/orders/:id/refund", refunds);

app.get("/health", (_req, res) => res.json({ ok: true }));

module.exports = app;
EOF

# Deliberately inside the 48-hour lookback in correlation/git.ts. At T-2d it
# fell two minutes outside it and was never offered as a candidate, which
# defeated the whole point of having it.
commit $(( 34 * HOUR )) "feat(ratelimit): per-client token bucket on write paths" \
"120 requests of burst, refilling at 2/s. Rejection is immediate and does
no work, so a flooding client cannot degrade latency for anyone else."

# --- T-30h  created_at format — DECOY touching orders.js ---------------------
cat > src/routes/orders.js <<'EOF'
const { Router } = require("express");
const db = require("../lib/db");

const router = Router();

function present(order) {
  return { ...order, created_at: new Date(order.created_at).toISOString() };
}

router.get("/", async (_req, res) => {
  const orders = await db.listOrders();
  res.json({ orders: orders.map(present) });
});

router.get("/:id", async (req, res) => {
  const order = await db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "not found" });
  res.json({ order: present(order) });
});

module.exports = router;
EOF

commit $(( 30 * HOUR )) "feat(orders): return created_at as ISO 8601" \
"Epoch milliseconds forced every consumer to know the unit. Breaking for
clients that parsed the number, which is why it ships behind the v1.4
release note."

# --- T-26h  extract formatPrice — DECOY touching pricing.js ------------------
cat > src/lib/pricing.js <<'EOF'
// Money formatting. Everything here takes minor units (cents) and returns a
// display string; nothing in this file does arithmetic on floats.
function formatPrice(cents) {
  return (cents / 100).toFixed(2);
}

module.exports = { formatPrice };
EOF

cat > src/routes/orders.js <<'EOF'
const { Router } = require("express");
const db = require("../lib/db");
const { formatPrice } = require("../lib/pricing");

const router = Router();

function present(order) {
  return {
    ...order,
    created_at: new Date(order.created_at).toISOString(),
    total: formatPrice(order.total_cents),
  };
}

router.get("/", async (_req, res) => {
  const orders = await db.listOrders();
  res.json({ orders: orders.map(present) });
});

router.get("/:id", async (req, res) => {
  const order = await db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "not found" });
  res.json({ order: present(order) });
});

module.exports = router;
EOF

commit $(( 26 * HOUR )) "refactor(pricing): extract formatPrice into lib/pricing" \
"Three call sites were formatting money inline and two of them rounded
differently. One function, minor units in, string out."

# --- T-6h  docs — DECOY with no code ----------------------------------------
cat > README.md <<'EOF'
# orders-api

Order placement, lookup and refunds.

## Refunds

A refund is accepted for 30 days after the order is placed, measured from
`created_at`. Requests outside that window return 422 — the request is well
formed, the order's state simply does not allow it.

## Rate limits

Write paths are limited per client to 120 requests of burst, refilling at
2 requests per second. Over the limit is a 429 with `retry-after`.
EOF

commit $(( 6 * HOUR )) "docs: describe the refund window and rate limits"

# --- T-95m  THE BUG ----------------------------------------------------------
# discounted_cents is NULL for every order without a promotion — which is most
# of them — and formatPrice is called on it unconditionally.
cat > src/lib/pricing.js <<'EOF'
// Money formatting. Everything here takes minor units (cents) and returns a
// display string; nothing in this file does arithmetic on floats.
function formatPrice(cents) {
  return (cents / 100).toFixed(2);
}

// Promotional pricing: an order carries the discounted total once a promotion
// has been applied to it.
function formatDiscountedPrice(order) {
  return formatPrice(order.discounted_cents);
}

module.exports = { formatPrice, formatDiscountedPrice };
EOF

cat > src/routes/orders.js <<'EOF'
const { Router } = require("express");
const db = require("../lib/db");
const { formatPrice, formatDiscountedPrice } = require("../lib/pricing");

const router = Router();

function present(order) {
  return {
    ...order,
    created_at: new Date(order.created_at).toISOString(),
    total: formatPrice(order.total_cents),
    discounted_total: formatDiscountedPrice(order),
  };
}

router.get("/", async (_req, res) => {
  const orders = await db.listOrders();
  res.json({ orders: orders.map(present) });
});

router.get("/:id", async (req, res) => {
  const order = await db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "not found" });
  res.json({ order: present(order) });
});

module.exports = router;
EOF

commit $(( 95 * MIN )) "feat(pricing): show the promotional total on order responses" \
"Adds discounted_total to every order response so the storefront can strike
through the original price without a second call."

# --- T-40m  CI — noise after the bug ----------------------------------------
mkdir -p .github/workflows
cat > .github/workflows/ci.yml <<'EOF'
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
EOF

commit $(( 40 * MIN )) "chore(ci): cache the pnpm store between runs" \
"Install was 90 seconds of every run. Cache key is the lockfile hash."

# --- report ------------------------------------------------------------------
echo ""
echo "Built $OUT"
echo ""
git --no-pager log --pretty=format:"  %h  %ad  %s" --date=format:"%Y-%m-%d %H:%M" | cat
echo ""
echo ""
echo "The bug:      $(git log --format=%h --grep='promotional total')  feat(pricing): show the promotional total on order responses"
echo "Decoys after: $(git log --format=%h --grep='pnpm store')  (so 'pick the newest' is wrong)"
echo "Same file:    $(git log --format=%h --grep='extract formatPrice')  (so 'pick by filename' is not enough)"
