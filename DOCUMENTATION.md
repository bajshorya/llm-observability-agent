# Technical Documentation

Complete reference for everything built so far: every file, what its code does,
how it works, and why it was written that way.

**Scope:** Phase 0 (foundations) and Phase 1 (Tier 1 detection). 21 TypeScript
files plus config. No LLM code exists yet — that is Phase 2. Sections 1–14 cover
Phase 0; section 15 covers Phase 1.

- [1. What the system is](#1-what-the-system-is)
- [2. How the finished pipeline will work](#2-how-the-finished-pipeline-will-work)
- [3. What Phase 0 actually delivers](#3-what-phase-0-actually-delivers)
- [4. Repository layout](#4-repository-layout)
- [5. Root configuration files](#5-root-configuration-files)
- [6. `packages/shared` — the contract](#6-packagesshared--the-contract)
- [7. `packages/backend` — ingestion and storage](#7-packagesbackend--ingestion-and-storage)
- [8. `packages/generator` — synthetic traffic](#8-packagesgenerator--synthetic-traffic)
- [9. The data model in detail](#9-the-data-model-in-detail)
- [10. Request lifecycle walkthrough](#10-request-lifecycle-walkthrough)
- [11. Algorithms explained](#11-algorithms-explained)
- [12. Design decisions and trade-offs](#12-design-decisions-and-trade-offs)
- [13. Bugs found during Phase 0](#13-bugs-found-during-phase-0)
- [14. Running and verifying](#14-running-and-verifying)
- [15. Phase 1 — the detection pipeline](#15-phase-1--the-detection-pipeline)
- [16. What comes next](#16-what-comes-next)

---


Beyond the stack fit, I like that it's end-to-end and close to the founding team. The work I've enjoyed most has been owning something across the whole system — frontend, backend, and the messy production debugging in between — rather than a narrow slice. Shipping real features to users on a small team is exactly how I want to work.
## 1. What the system is

An **observability agent**. It watches a running application's logs, notices when
something breaks, works out which recent code change caused it, and writes a
plain-English explanation plus a suggested fix — showing its full reasoning so a
human can audit the conclusion.

### The problem

When a production service breaks, an on-call engineer does the same detective work
every time:

1. Read dashboards to work out **what** broke
2. Dig through logs to find the actual error
3. Scroll recent commits guessing **which change** caused it
4. Read the diff to understand **why**
5. Work out the fix

Steps 1–4 take 30–60 minutes and are almost entirely mechanical. All the
information needed is already present — in the logs and in the git history.
Nobody has connected the two.

This project connects them.

### The central design idea

The naive version sends every log line to an LLM and asks "anything wrong?" That
is slow, expensive, and *worse* — the model drowns in noise.

This system uses a **two-tier funnel**:

```
All logs
   │
   ▼
Tier 1: statistics          ← free, deterministic, runs on everything
   │  (error-rate spike, latency jump, new error signature)
   │
   ▼  only flagged windows (~5%)
Tier 2: LLM classification  ← costs money, so it only sees what matters
   │
   ▼  only confirmed incidents
Correlation agent → Root-cause agent → Dashboard
```

Statistics handle the obvious 90% for free. The LLM is invoked only where semantic
understanding genuinely adds something a threshold cannot provide — a brand-new
error string, a subtly reworded message, a benign deploy restart that *looks*
statistically identical to an outage.

---

## 2. How the finished pipeline will work

A concrete incident, end to end. Steps 1–5 are built.

| # | Step | Phase | What happens |
|---|---|---|---|
| 1 | App emits logs | 0 ✅ | Structured JSON per request |
| 2 | `POST /ingest` | 0 ✅ | Validate against Zod, persist to SQLite |
| 3 | Baseline exists | 0 ✅ | Generator backfills healthy history |
| 4 | Rollup worker | 1 ✅ | Raw logs → per-minute aggregates |
| 5 | Tier 1 detectors | 1 ✅ | Statistics flag a suspicious window → anomaly candidate |
| 6 | Tier 2 classifier | 2 | LLM: severity, summary, is this real? |
| 7 | Correlation agent | 3 | Fetch commits near the window, rank the culprit |
| 8 | Root-cause agent | 4 | Anomaly + diff → hypothesis + fix |
| 9 | Human gate | 4 | `applied = false`. The agent never writes code. |
| 10 | Dashboard | 5 | Timeline → click → full reasoning trace |

---

## 3. What Phase 0 actually delivers

Phase 0 is the **foundation you can develop everything else against**. Three
things had to exist before any detector could be written:

1. **A shared contract** — one definition of what a log entry is, imported by
   every package, so ingestion and detection cannot drift apart.
2. **Somewhere to put data** — a schema covering the whole pipeline, not just
   today's needs, so later phases add code rather than migrations.
3. **Data to develop against** — this is why the synthetic generator came
   *first*, before the ingestion endpoint that consumes it.

That last point drives the whole ordering. Detection compares a window against a
**trailing baseline**. Without a generator that can produce three hours of
believable history instantly, you would sit and wait three hours in real time
before a detector could say anything at all.

**Verified working:** 47,078 log entries ingested with zero rejections, malformed
entries rejected with per-index reasons, error signatures collapsing correctly.

---

## 4. Repository layout

```
Agent_1/
├── package.json               Workspace root — scripts, dev tooling
├── pnpm-workspace.yaml        Declares packages/* as workspace members
├── tsconfig.base.json         Shared strict TypeScript config
├── .gitignore
├── .env.example               Documented config template
├── README.md                  Quick start + design notes
├── DOCUMENTATION.md           This file — Phase 0 reference
├── DOCUMENTATION-PHASE-1.md   Phase 1 reference (Tier 1 detection)
├── observability-agent-architecture.md    Original plan
├── data/
│   └── dev.db                 SQLite database (gitignored)
└── packages/
    ├── shared/                The contract every package imports
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts               Barrel export
    │       ├── signature.ts           Error-signature normalisation
    │       └── schemas/
    │           ├── log.ts             Log entry + ingest contract
    │           ├── anomaly.ts         Tier 1 triggers, statuses
    │           └── agents.ts          LLM output schemas (Phase 2+)
    ├── backend/               Ingestion API and storage
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── drizzle.config.ts
    │   └── src/
    │       ├── env.ts                 Validated environment config
    │       ├── server.ts              Fastify bootstrap
    │       ├── routes/ingest.ts       POST /ingest
    │       ├── db/
    │       │   ├── schema.ts          All six tables
    │       │   └── client.ts          SQLite connection
    │       └── detection/             Tier 1 — statistics only (Phase 1)
    │           ├── config.ts          Every threshold, in one place
    │           ├── stats.ts           mean, stddev, percentile, median (pure)
    │           ├── detectors.ts       The three detectors (pure)
    │           ├── rollup.ts          Raw logs -> per-minute aggregates
    │           ├── engine.ts          Load, detect, persist anomalies
    │           ├── cli.ts             pnpm detect
    │           ├── stats.test.ts      Unit tests
    │           └── detectors.test.ts  Unit tests
    └── generator/             Synthetic traffic + anomaly injection
        ├── package.json
        ├── tsconfig.json
        └── src/
            ├── index.ts               CLI
            ├── scenarios.ts           Traffic profiles + anomalies
            └── random.ts              Seeded PRNG
```

### Dependency direction

```
generator ──┐
            ├──▶ shared     (shared depends on nothing but zod)
backend  ───┘
```

`shared` is the only package both others import, and it imports neither of them.
This is deliberate: it makes circular dependencies structurally impossible and
means the contract can never be "adjusted" by one side without the other seeing it.

---

## 5. Root configuration files

### `pnpm-workspace.yaml`

```yaml
packages:
  - "packages/*"
```

Tells pnpm that every directory under `packages/` is a workspace member. This is
what makes `"@obs/shared": "workspace:^"` resolve to the local folder via a symlink
instead of being fetched from npm.

### `package.json` (root)

Private, `"type": "module"` (ESM throughout), and pins `packageManager` so everyone
uses the same pnpm version.

The scripts are thin wrappers that delegate into packages, so you can run
everything from the repo root without remembering which package owns what:

| Script | Runs |
|---|---|
| `pnpm backend` | `tsx watch src/server.ts` in backend |
| `pnpm generate` | The generator CLI |
| `pnpm db:push` | `drizzle-kit push` |
| `pnpm db:studio` | Database browser UI |
| `pnpm typecheck` | `tsc --noEmit` in **every** package |

Dev dependencies live at the root because all three packages use them:
`typescript`, `tsx` (runs TypeScript directly, no build step), `@types/node`.

### `tsconfig.base.json`

Every package extends this. The interesting choices:

```jsonc
{
  "module": "ESNext",
  "moduleResolution": "Bundler",   // lets imports omit .js extensions
  "types": ["node"],               // see note below
  "noEmit": true,                  // tsx runs TS directly; tsc only typechecks

  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "verbatimModuleSyntax": true,
  "noUnusedLocals": true,
  "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true,
  "isolatedModules": true
}
```

**`moduleResolution: "Bundler"`** — imports are written `from "./scenarios"`, not
`"./scenarios.js"`. Under Node's native ESM resolution you must write the `.js`
extension even though the file is `.ts`, which confuses everyone. `tsx` handles
resolution at runtime, so Bundler mode is both correct and readable here.

**`types: ["node"]`** — normally TypeScript auto-discovers `@types/*` by walking up
`node_modules`. Under pnpm's isolated (symlinked) layout that discovery failed, and
the compiler could not find `console`, `process`, or `fetch`. Naming the types
explicitly fixes it and has a side benefit: type inclusion becomes deterministic
rather than dependent on directory layout.

**`noUncheckedIndexedAccess`** — `array[0]` is typed `T | undefined`. Verbose, but
it is exactly the class of bug that produces `Cannot read properties of undefined`
in production. This is the same category of failure the agent is being built to
diagnose, so tolerating it here would be embarrassing.

**`exactOptionalPropertyTypes`** — distinguishes "key absent" from "key present and
set to `undefined`". This caught a real mistake during Phase 0 (see §13).

**`verbatimModuleSyntax`** — forces `import type { Foo }` for type-only imports, so
what gets erased at runtime is explicit rather than inferred.

### `.env.example`

A documented template covering all phases, so nothing has to be reverse-engineered
later. Copied to `.env`, which is gitignored. Every value has a working local
default; **no keys are needed until Phase 2.**

### `.gitignore`

Ignores `node_modules/`, build output, `.env*`, and `data/*.db*`. The database is
deliberately disposable — resetting the demo is `rm data/dev.db && pnpm db:push`.

---

## 6. `packages/shared` — the contract

The single source of truth for every data shape crossing a boundary. Depends only
on `zod`.

### `package.json` — the internal-package pattern

```json
{
  "name": "@obs/shared",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" }
}
```

Note this points at **`.ts` source**, not compiled `dist/`. There is no build step
between packages: edit a schema in `shared`, and `backend` sees the change
immediately. `tsx` compiles on the fly and `tsc` typechecks across the boundary.

Trade-off: this only works because everything is TypeScript run through `tsx`. If
`shared` were ever published to npm, it would need a real build.

### `src/index.ts` — barrel export

```ts
export * from "./schemas/log";
export * from "./schemas/anomaly";
export * from "./schemas/agents";
export * from "./signature";
```

Consumers write `import { logEntrySchema } from "@obs/shared"` without caring about
internal file structure — files can be reorganised without touching importers.

### `src/schemas/log.ts` (101 lines)

The wire contract for log entries.

**Levels.**

```ts
export const LOG_LEVELS = ["info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];   // "info"|"warn"|"error"|"fatal"
export const logLevelSchema = z.enum(LOG_LEVELS);
```

The `as const` array is the single definition; both the TypeScript union and the
runtime Zod validator derive from it. Adding a level means editing one line, and
type and validation cannot fall out of sync.

**Two different level predicates.** This distinction matters:

```ts
export const ERROR_LEVELS     = ["error", "fatal"];            // isErrorLevel()
export const SIGNATURE_LEVELS = ["warn", "error", "fatal"];    // hasErrorSignature()
```

- `isErrorLevel` — counts towards the **error-rate spike** detector. A 404 is not
  a service failure, so warnings must not inflate the error rate.
- `hasErrorSignature` — decides which entries get a **normalised signature**. Wider
  on purpose: a 404 is not an error, but a *new kind* of 404 appearing is still a
  regression worth catching.

Collapsing these into one predicate was a bug, fixed in §13.

**Metadata — typed but open.**

```ts
export const logMetadataSchema = z.object({
  requestId:  z.string().max(128).optional(),
  endpoint:   z.string().max(256).optional(),
  method:     z.string().max(16).optional(),
  statusCode: z.number().int().min(100).max(599).optional(),
  latencyMs:  z.number().nonnegative().max(600_000).optional(),
  errorType:  z.string().max(128).optional(),
  stack:      z.string().max(8192).optional(),
}).catchall(z.unknown());
```

`.catchall(z.unknown())` allows arbitrary extra fields. Known fields get real
types and validation; a monitored service can attach its own context without us
redeploying the schema. Every string has a `.max()` — an unbounded `stack` field is
a memory-exhaustion vector.

**The entry itself.**

```ts
export const logEntrySchema = z.object({
  timestamp: z.coerce.date({
    error: "must be an ISO-8601 string or epoch milliseconds",
  }),
  service:  z.string().min(1).max(64),
  level:    logLevelSchema,
  message:  z.string().min(1).max(4096),
  metadata: logMetadataSchema.default({}),
});
```

`z.coerce.date()` accepts an ISO string *or* epoch milliseconds — clients shouldn't
have to care which. The custom `error` message replaces Zod's default
(`expected date, received Date`), which explains nothing to someone integrating a
new service.

`.default({})` means omitting `metadata` yields `{}`, not `undefined`, so consumers
never null-check it.

**Two exported types:**

```ts
export type LogEntry      = z.infer<typeof logEntrySchema>;   // after parsing
export type LogEntryInput = z.input<typeof logEntrySchema>;   // before parsing
```

`LogEntry.timestamp` is a `Date` and `metadata` is guaranteed present.
`LogEntryInput` is the looser pre-coercion shape, which the generator produces.

**Batch envelope and result.**

```ts
export const MAX_BATCH_SIZE = 1000;
export const ingestBatchSchema = z.object({
  entries: z.array(logEntrySchema).min(1).max(MAX_BATCH_SIZE),
});

export const ingestResultSchema = z.object({
  accepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  errors: z.array(z.object({
    index:  z.number().int().nonnegative(),
    reason: z.string(),
  })).max(20),
});
```

The result shape encodes the **partial-success** policy: batches report counts and
per-index reasons rather than succeeding or failing as a unit.

### `src/signature.ts` (52 lines)

The most important algorithm in Phase 0. Fully explained in §11.1.

Exports one pure function:

```ts
normalizeErrorSignature(message: string): string
```

It applies an ordered list of regex replacements to strip variable detail —
UUIDs, timestamps, hex, quoted strings, paths, numbers — collapsing many raw
messages onto one stable key.

### `src/schemas/anomaly.ts` (75 lines)

What Tier 1 produces.

**Statuses and severities** follow the same `as const` + `z.enum` pattern:

```ts
anomalyStatuses = ["open","correlated","diagnosed","dismissed","resolved"]
severities      = ["low","medium","high","critical"]
```

The statuses trace the pipeline: `open` → `correlated` (commit found) →
`diagnosed` (hypothesis written), with `dismissed` and `resolved` as terminals.

**Triggers — a discriminated union.** Each detector produces a differently-shaped
trigger carrying its own evidence:

```ts
errorRateSpike:     { kind, service, observedErrors, baselineMean, baselineStdDev, zScore }
latencyJump:        { kind, service, metric: "p95"|"p99", observedMs, baselineMs, ratio }
newErrorSignature:  { kind, service, signature, sampleMessage, occurrences }

export const anomalyTriggerSchema = z.discriminatedUnion("kind", [...]);
```

Why a discriminated union rather than a loose bag of optional fields: narrowing on
`trigger.kind` gives you exactly the right fields with no optional-chaining, and
adding a fourth detector later is a compile error everywhere it must be handled
rather than a silent gap.

Each trigger carries the numbers that produced it (`zScore`, `baselineMean`), so
the dashboard can show *why* something fired, not just that it did. That is the
reasoning trace starting at the very first step.

### `src/schemas/agents.ts` (74 lines)

LLM output contracts. Written now, used in Phase 2+ — defining them early keeps the
"every model output is structured" rule from being retrofitted.

| Schema | Agent | Key fields |
|---|---|---|
| `classificationSchema` | Tier 2 classifier | `severity`, `summary`, `isRealIncident`, `affectedArea` |
| `correlationSchema` | Correlation | `suspectedCommitSha` (nullable), `confidence`, `reasoning`, `changedFilesImplicated` |
| `hypothesisSchema` | Root cause | `rootCause`, `suggestedFix`, `confidence` |
| `llmCallStatsSchema` | All | `provider`, `model`, tokens, `latencyMs`, `repairAttempts`, `succeeded` |

Details worth noting:

- **`isRealIncident`** is the judgement statistics cannot make. A deploy restart
  looks identical to an outage on a graph; it does not look identical in log text.
- **`suspectedCommitSha` is nullable.** The model must be able to say "none of
  these commits explains it" rather than being forced to blame something.
- **`repairAttempts`** counts how many times output failed Zod validation and had
  to be retried — the parse-repair loop planned for Phase 2.
- **`llmCallStats`** is what substantiates the entire two-tier argument. Without
  recorded tokens and latency, "the LLM only fires on ~5% of windows" is a claim;
  with them it is a measurement.

---

## 7. `packages/backend` — ingestion and storage

### `src/env.ts` (33 lines)

Configuration, validated at startup.

```ts
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
```

The repo root is derived from **this file's own location**, not `process.cwd()`.
That is what makes the database land in the same place whether you run from the
workspace root (`pnpm backend`) or inside the package (`pnpm dev`). Anything
cwd-relative would silently create a second database.

```ts
try { process.loadEnvFile(resolve(REPO_ROOT, ".env")); } catch { /* defaults */ }
```

Node's built-in `.env` loader — no `dotenv` dependency. Missing file is fine
because every value has a default.

```ts
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) { /* print each issue, process.exit(1) */ }
```

**Fail fast, loudly.** A bad `PORT` kills the process at startup with a readable
message rather than producing a confusing error later. `z.coerce.number()` handles
the fact that env vars are always strings.

### `src/db/schema.ts` (166 lines)

All six tables, in Drizzle. Full field-by-field breakdown in §9.

**Shared column helpers** remove repetition and guarantee consistency:

```ts
const id = () => text("id").primaryKey().$defaultFn(() => randomUUID());
const createdAt = () => integer("created_at", { mode: "timestamp_ms" })
                          .notNull().$defaultFn(() => new Date());
```

`$defaultFn` generates values in **application code**, not via a database default.
That keeps behaviour identical across SQLite and Postgres.

**Typed JSON columns:**

```ts
metadata: text("metadata", { mode: "json" }).$type<LogMetadata>().notNull(),
triggers: text("triggers", { mode: "json" }).$type<AnomalyTrigger[]>().notNull(),
```

`mode: "json"` serialises and deserialises automatically. `$type<>()` attaches the
TypeScript type — so `anomaly.triggers[0].kind` is fully typed and narrowable,
even though SQLite stores a string.

**Postgres compatibility** is the reason for the storage choices:

| Concept | SQLite (now) | Postgres (later) |
|---|---|---|
| Timestamp | `integer(mode: "timestamp_ms")` | `timestamptz` |
| JSON | `text(mode: "json")` | `jsonb` |
| Boolean | `integer(mode: "boolean")` | `boolean` |
| Float | `real` | `double precision` |

Drizzle exposes all of these as `Date`, typed objects, and `boolean` in
application code. Migrating means editing the column builders in this one file and
the driver in `client.ts` — **no query or application code changes.**

**Indexes** are declared per table:

```ts
(t) => [
  index("logs_service_timestamp_idx").on(t.service, t.timestamp),
  index("logs_signature_idx").on(t.service, t.errorSignature),
]
```

The first exists because *every* detection query is time-windowed per service. The
second makes "have we seen this signature in the baseline window?" an indexed
lookup instead of a table scan.

**Inferred row types** are exported so other modules never hand-write them:

```ts
export type LogRow    = typeof logs.$inferSelect;
export type NewLogRow = typeof logs.$inferInsert;
```

### `src/db/client.ts` (23 lines)

The connection, and the only file that knows the database is SQLite.

```ts
function resolveDatabasePath(url: string): string {
  const raw = url.replace(/^file:/, "");
  return isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw);
}
```

Accepts `file:./data/dev.db` (URL style, matching how Postgres/Turso are
configured) or a plain path, and resolves relative paths against the repo root.

```ts
mkdirSync(dirname(databasePath), { recursive: true });
const sqlite = new Database(databasePath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
```

- **`mkdirSync`** — first run works on a clean checkout with no `data/` directory.
- **WAL (Write-Ahead Logging)** — readers do not block writers. The ingestion
  endpoint keeps writing while detection queries read. Without it, SQLite locks
  the whole database per write and the two would contend.
- **`foreign_keys = ON`** — SQLite disables FK enforcement *by default*. Without
  this, `onDelete: "cascade"` on `correlations` and `hypotheses` silently does
  nothing and deleting an anomaly orphans its rows.

### `src/routes/ingest.ts` (95 lines)

The `POST /ingest` endpoint. Deliberately the dumbest file in the project: it
validates and persists, nothing more. It sits in the hot path of every monitored
service, so the only things it is allowed to be are correct and fast.

**Two-stage validation.**

```ts
const envelopeSchema = z.object({
  entries: z.array(z.unknown()).min(1).max(MAX_BATCH_SIZE),
});
```

The envelope is checked first with entries typed as `unknown` — this validates the
*shape* of the request (is there an array, is it a sane size) without validating
contents. A malformed envelope means the client is fundamentally broken, so it gets
a flat `400`.

Then each entry is validated **individually**:

```ts
envelope.data.entries.forEach((raw, index) => {
  const parsed = logEntrySchema.safeParse(raw);
  if (!parsed.success) {
    if (errors.length < MAX_REPORTED_ERRORS) {
      errors.push({ index, reason: describeIssue(parsed.error) });
    }
    return;                       // skip it, keep going
  }
  rows.push({ /* ... */ });
});
```

This is the partial-success policy. `safeParse` returns a result object instead of
throwing, so one bad entry costs you that entry and nothing else. Reported errors
are capped at 20 — enough to debug, not enough for a broken client to make us
serialise 1,000 error strings.

**Signature computed at write time:**

```ts
errorSignature: hasErrorSignature(entry.level)
  ? normalizeErrorSignature(entry.message)
  : null,
```

A deliberate, small exception to "keep ingestion dumb" — justified because it is a
pure O(1) string transform, and it converts the new-signature detector from a regex
pass over millions of rows into an indexed lookup.

**Chunked inserts:**

```ts
for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {   // 250
  await db.insert(logs).values(rows.slice(i, i + INSERT_CHUNK_SIZE));
}
```

SQLite caps bound parameters per statement. 250 rows × 7 columns = 1,750
parameters, comfortably under the limit with room for the schema to grow.

**Status codes carry meaning:**

| Code | Meaning |
|---|---|
| `202 Accepted` | Every entry stored |
| `207 Multi-Status` | Some stored, some rejected — check `errors[]` |
| `400 Bad Request` | Envelope malformed; nothing stored |

`207` is the important one: it lets a client detect partial failure without
treating the whole batch as lost.

### `src/server.ts` (58 lines)

Fastify bootstrap.

```ts
const loggerOptions =
  env.NODE_ENV === "development"
    ? { level: "debug", transport: { target: "pino-pretty", options: {...} } }
    : { level: env.NODE_ENV === "production" ? "info" : "warn" };
```

Built as two separate object literals rather than one with
`transport: undefined`. Under `exactOptionalPropertyTypes`, an explicit `undefined`
is *not* the same as an absent key, and Fastify's types correctly reject it. Pretty
logs in development; raw JSON in production, where a log aggregator consumes it.

```ts
bodyLimit: 16 * 1024 * 1024,
```

Fastify defaults to 1 MB. A 1,000-entry batch with stack traces exceeds that
easily, so the limit is raised to 16 MB — still bounded.

**Health endpoint** proves the whole stack, not just the process:

```ts
app.get("/health", async () => {
  const [row] = await db.select({ value: count() }).from(logs);
  return { status: "ok", database: databasePath, logCount: row?.value ?? 0 };
});
```

It executes a real query, so it fails if the database is unreachable. Returning
`databasePath` catches the "why is my data missing?" case where two database files
exist. `row?.value ?? 0` is `noUncheckedIndexedAccess` doing its job.

**Graceful shutdown:**

```ts
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void app.close().then(() => process.exit(0)); });
}
```

`app.close()` drains in-flight requests before exiting, so Ctrl-C cannot truncate a
half-written batch.

### `drizzle.config.ts` (12 lines)

Configures `drizzle-kit`, the schema migration tool. Points at
`src/db/schema.ts`, uses the `sqlite` dialect, and targets `../../data/dev.db`
(relative to the package, resolving to the repo root).

`drizzle-kit push` diffs the schema against the live database and applies the
difference — no migration files during rapid development. Later phases can switch
to `drizzle-kit generate` for versioned migrations.

---

## 8. `packages/generator` — synthetic traffic

Built **before** the ingestion endpoint. It provides data to develop against from
day one and later becomes the demo driver.

### `src/random.ts` (49 lines)

A seeded PRNG. `Math.random()` cannot be seeded, which would make every run
different — unacceptable for a fixture that both tests must assert against and a
demo must reproduce.

**mulberry32** — a compact, fast, well-distributed 32-bit PRNG:

```ts
let state = seed >>> 0;
const next = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
```

The `Rng` interface wraps it in useful primitives:

| Method | Purpose |
|---|---|
| `next()` | Float in `[0, 1)` |
| `int(min, max)` | Integer, inclusive both ends |
| `pick(items)` | Uniform choice from an array |
| `bool(p)` | `true` with probability `p` |
| `latency(median, tail)` | Log-normal positive value (see §11.2) |

`pick` throws on an empty array rather than returning `undefined` — with
`noUncheckedIndexedAccess`, that keeps every call site from needing a null check.

### `src/scenarios.ts` (216 lines)

Defines what healthy and unhealthy traffic look like.

**Traffic profile:**

```ts
export const BASELINE: TrafficProfile = {
  service: "orders-api",
  requestsPerMinute: 240,
  errorRate: 0.008,          // 0.8%
  latencyMedianMs: 45,
  latencyTailFactor: 3,
};
```

**Weighted endpoints** — realistic traffic is not uniform:

| Endpoint | Weight | Latency × |
|---|---|---|
| `GET /orders/:id` | 8 | 0.8 |
| `GET /orders` | 5 | 1.0 |
| `POST /orders` | 3 | 2.2 |
| `POST /orders/:id/refund` | 1 | 3.0 |

Reads dominate, writes are slower. `pickEndpoint` walks the weights with a single
random roll.

**Baseline errors are generated per occurrence:**

```ts
export interface FailureKind {
  message: (rng: Rng) => string;
  errorType: string;
  statusCode: number;
}

const BASELINE_ERRORS: readonly FailureKind[] = [
  { message: (r) => `Upstream timeout contacting payments-service after ${r.pick([2500,3000,5000])}ms`,
    errorType: "UpstreamTimeoutError", statusCode: 504 },
  { message: (r) => `Order ${r.int(10_000, 99_999)} not found`,
    errorType: "NotFoundError", statusCode: 404 },
  { message: (r) => `Rate limit exceeded for client ${r.int(1_000, 9_999)}`,
    errorType: "RateLimitError", statusCode: 429 },
];
```

`message` is a **function**, not a string. This is what actually exercises
signature normalisation — with hardcoded ids every message would be byte-identical
and a completely broken normaliser would still pass, because there would be nothing
to collapse. This was tightened during Phase 0 (§13.3).

Note two of the three are 4xx and therefore log at `warn`, which is why the
`SIGNATURE_LEVELS` / `ERROR_LEVELS` split matters.

**Scenarios:**

| Name | Effect | Purpose |
|---|---|---|
| `error-spike` | `errorRate` → 0.35 (~40×), reusing known errors | Tests error-rate detector *without* tripping the new-signature detector |
| `latency-jump` | median × 8, tail × 1.6, error rate unchanged | Tests latency detector in isolation |
| `new-error` | `errorRate` → 0.30 plus a novel signature | Tests new-signature detection |

Each isolates one detector. `error-spike` deliberately reuses baseline errors so it
cannot accidentally pass by triggering the wrong detector.

The `new-error` message is
`TypeError: Cannot read properties of null (reading 'toFixed')` — chosen to match
the null-price bug that will be committed to the target app in Phase 3, so the
correlation agent has something *true* to find.

**Diurnal curve:**

```ts
function diurnalMultiplier(at: Date): number {
  const hour = at.getUTCHours() + at.getUTCMinutes() / 60;
  return 0.75 + 0.35 * Math.sin(((hour - 9) / 24) * 2 * Math.PI);
}
```

Traffic varies between 0.4× and 1.1× across the day. Without it, a flat baseline
would let a naive fixed threshold look as good as a proper `mean + k·stddev`
detector — the fixture would be flattering the code rather than testing it.

**Generation:**

```ts
export function generateMinute(
  profile, windowStart, rng, scenario?, windowMs = 60_000
): GeneratedEntry[]
```

Per call: compute request count (rate × window × diurnal × jitter), then for each
request pick an endpoint, roll a latency, decide success or failure, and build an
entry with a random offset inside the window. Results are sorted by timestamp.

`windowMs` is parameterised so `live` mode can emit 5-second slices using the same
code path as the 60-second batches.

```ts
export type GeneratedEntry = LogEntryInput & { timestamp: Date };
```

`LogEntryInput.timestamp` is deliberately permissive (Zod coerces strings, numbers,
or Dates), which means it cannot be sorted. This intersection type pins it to a
real `Date` internally while staying assignable to `LogEntryInput`.

### `src/index.ts` (247 lines)

The CLI, built on Node's `parseArgs` — no dependency.

| Command | Default | Purpose |
|---|---|---|
| `backfill` | 120 min | Generate healthy history ending now, all at once |
| `inject` | 5 min | Generate anomalous traffic ending now — the demo trigger |
| `live` | — | Emit healthy traffic continuously in 5s ticks |

| Option | Purpose |
|---|---|
| `--minutes <n>` | Duration to generate |
| `--scenario <s>` | `error-spike` \| `latency-jump` \| `new-error` |
| `--service <name>` | Service name |
| `--rpm <n>` | Requests per minute |
| `--seed <n>` | PRNG seed (default 42) |
| `--url <url>` | Ingestion endpoint |
| `-h, --help` | Usage |

**Why `backfill` matters most.** It generates *past* timestamps and posts them
immediately:

```ts
const startMs = now - options.minutes * 60_000;
for (let minute = 0; minute < options.minutes; minute += 1) {
  entries.push(...generateMinute(profile, new Date(startMs + minute * 60_000), rng, scenario));
}
```

Three hours of history arrive in about two seconds. Detection needs a trailing
baseline; without this you would wait three real hours before testing anything.

**Sending** chunks at 500 entries per request (under the server's 1,000 cap) and
aggregates results. Connection failure produces an actionable message rather than a
raw stack:

```
Could not reach the ingestion endpoint at http://localhost:4000/ingest.
Is the backend running (`pnpm backend`)?
```

`207` is explicitly treated as success-with-warnings, matching the server contract.

**Reporting** prints accepted/rejected counts plus the observed error rate, which
is a cheap sanity check that the scenario did what it claimed:

```
Backfill complete: 47078 accepted, 0 rejected (129 errors, 0.3% error rate)
Injection complete: 1330 accepted, 0 rejected (401 errors, 30.2% error rate)
```

---

## 9. The data model in detail

### `logs`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | UUID from `randomUUID()` |
| `timestamp` | integer (ms) | When the event happened — **not** when it was received |
| `service` | text | Which service emitted it |
| `level` | text | `info` \| `warn` \| `error` \| `fatal` |
| `message` | text | Raw message |
| `error_signature` | text, nullable | Normalised key; null for `info` |
| `metadata` | text (json) | Request id, endpoint, latency, status… |

Indexes: `(service, timestamp)`, `(service, error_signature)`.

### `metrics_rollup`

Per-minute aggregates so detection reads cheap summaries rather than millions of
rows.

| Column | Notes |
|---|---|
| `bucket_start` | Minute boundary |
| `service`, `endpoint` | Grouping keys |
| `request_count`, `error_count` | Counts |
| `p50_ms`, `p95_ms`, `p99_ms` | Latency percentiles |

`uniqueIndex(service, endpoint, bucket_start)` makes the rollup worker **idempotent**
— re-running it cannot produce duplicate buckets.

### `anomalies`

| Column | Filled by | Notes |
|---|---|---|
| `detected_at`, `window_start`, `window_end`, `service` | Tier 1 | |
| `triggers` (json) | Tier 1 | Array of discriminated-union triggers |
| `severity`, `summary`, `is_real_incident` | Tier 2 | **Nullable** until the LLM runs |
| `status` | Pipeline | `open` → `correlated` → `diagnosed` |

The nullable Tier 2 columns are the schema-level expression of the two-tier design:
an anomaly is a complete, valid record with **zero** LLM involvement. Tier 2
enriches it.

### `correlations`

`anomaly_id` (FK, cascade), `suspected_commit_sha` (nullable), `confidence`,
`reasoning`, `implicated_files` (json).

### `hypotheses`

`anomaly_id` (FK, cascade), `root_cause`, `suggested_fix`, `confidence`,
`applied` (boolean, default **false**).

`applied` stays `false`. The agent diagnoses; a human decides whether to act. This
is the human-in-the-loop gate expressed in the schema rather than in a comment.

### `llm_calls`

`anomaly_id` (FK, nullable), `provider`, `model`, `agent`, `input_tokens`,
`output_tokens`, `latency_ms`, `repair_attempts`, `succeeded`.

The evidence table for the cost argument.

---

## 10. Request lifecycle walkthrough

What happens when the generator sends a batch.

**1. Generator builds entries.** `generateMinute` produces `GeneratedEntry[]` with
real `Date` timestamps.

**2. Chunk and POST.** 500 entries per request:

```json
{ "entries": [
  { "timestamp": "2026-07-28T13:07:51.412Z",
    "service": "orders-api",
    "level": "info",
    "message": "GET /orders/:id 200",
    "metadata": { "requestId": "…", "endpoint": "/orders/:id",
                  "method": "GET", "statusCode": 200, "latencyMs": 38 } }
] }
```

**3. Fastify receives it.** Body parsed as JSON, checked against the 16 MB limit.

**4. Envelope validation.** Is `entries` an array of 1–1,000? No → `400`, nothing
stored.

**5. Per-entry validation.** Each entry through `logEntrySchema.safeParse`:
- Valid → coerced (timestamp becomes a `Date`, metadata defaults to `{}`) and
  pushed to `rows`
- Invalid → `{ index, reason }` recorded; loop continues

**6. Signature computation.** For `warn`/`error`/`fatal`,
`normalizeErrorSignature(message)` runs. For `info`, `null`.

**7. Chunked insert.** 250 rows per statement. Drizzle serialises `metadata` to
JSON text and `timestamp` to epoch ms.

**8. Response.**

```json
{ "accepted": 499, "rejected": 1,
  "errors": [{ "index": 12, "reason": "level: Invalid option: expected one of \"info\"|\"warn\"|\"error\"|\"fatal\"" }] }
```

with `207` (partial) or `202` (all accepted).

**9. Generator aggregates** across chunks and prints the summary.

---

## 11. Algorithms explained

### 11.1 Error-signature normalisation

**The problem.** Two log lines describing the same failure rarely match
byte-for-byte:

```
Order 88213 not found
Order 41902 not found
Order 77341 not found
```

Three strings, one failure mode. A detector asking "have I seen this error before?"
would call every one novel and fire constantly on healthy traffic.

**The solution.** Strip variable detail with ordered replacements:

| Order | Pattern | Replacement | Why this order |
|---|---|---|---|
| 1 | UUID | `<uuid>` | Must precede numbers, or its digits get eaten first |
| 2 | ISO-8601 timestamp | `<timestamp>` | Same reason |
| 3 | `0x…` / long hex | `<hex>` | Object ids, hashes |
| 4 | `'…'` and `"…"` | `<str>` | The specific bad input, not the failure mode |
| 5 | `/a/b/c` paths | `<path>` | |
| 6 | Digit runs | `<num>` | Everything left over |

Then collapse whitespace, trim, truncate to 512 characters.

**Ordering is load-bearing.** If numbers were replaced first,
`a3f9c21b-4e1f-…` would become `<num>a<num>f…` and the UUID rule could never match.

**The number regex:**

```ts
[/\b\d+(?:[.,]\d+)*/g, "<num>"]
```

- Leading `\b` protects digits embedded in identifiers — `utf8` and `ipv4` are
  untouched, because there is no word boundary inside a word.
- **No trailing `\b`** — this is the fix from §13.1. A unit suffix like the `ms` in
  `after 3000ms` is a word character, so requiring a boundary there would leave the
  digits alone and make `3000ms` and `5000ms` two different signatures.

**Measured result** on a 120-minute baseline plus one 5-minute `new-error`
injection (the currently seeded database holds baseline only, so it shows the
first three rows):

| Signature | Entries | Distinct raw messages |
|---|---|---|
| `Rate limit exceeded for client <num>` | 87 | **87** |
| `Order <num> not found` | 79 | **79** |
| `Upstream timeout … after <num>ms` | 91 | 3 |
| `TypeError: … (reading <str>)` | 401 | 1 |

87 distinct strings → one key. Without this, the new-signature detector would flag
roughly 170 "novel" errors per minute of perfectly healthy traffic.

### 11.2 Log-normal latency

Real latency is **not** normally distributed. It has a floor (nothing takes
negative time), a dense cluster near the median, and a long right tail from
retries, cold caches, and GC pauses. A normal distribution would produce
symmetric — and occasionally negative — values.

```ts
latency: (medianMs, tailFactor) => {
  const u1 = Math.max(next(), Number.EPSILON);
  const u2 = next();
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const sigma = Math.log(tailFactor) / 2;
  return Math.max(1, Math.round(medianMs * Math.exp(normal * sigma)));
}
```

Box–Muller turns two uniform samples into a standard normal; exponentiating makes
it log-normal. `medianMs` sets the centre, `tailFactor` the spread.

This matters because the latency detector works on **p95/p99**. A fixture without a
realistic tail would make percentile detection trivially easy and hide bugs.

### 11.3 Seeded determinism

Every random value flows from one `createRng(seed)`. Same seed → identical output,
byte for byte. Two payoffs:

- A failing detector test reproduces exactly instead of intermittently.
- The demo tells the same story every run, with the same numbers.

---

## 12. Design decisions and trade-offs

| Decision | Rationale | Trade-off accepted |
|---|---|---|
| **Generator before detectors** | Detection needs a trailing baseline; waiting hours in real time is untenable | Generator built before its consumer existed |
| **SQLite, not Postgres** | Zero setup, no Docker (not installed on this machine), instant reset | No `jsonb`/`timestamptz`; mitigated by keeping the schema Postgres-shaped |
| **Signature computed at ingest** | Turns detection into an indexed lookup instead of a regex scan | Slightly more than "validate and persist" in the hot path |
| **Partial-success ingestion** | One bad entry shouldn't cost 499 good ones | Clients must check `rejected`, not just HTTP status |
| **`shared` exports `.ts` directly** | No build step; edits are instantly visible across packages | Only works because everything runs through `tsx` |
| **Strict TS everywhere** | Catches the exact null/undefined bug class the agent diagnoses | More verbose; needed real fixes (§13.2) |
| **Zod schemas in `shared`** | Ingestion and detection cannot drift apart | Runtime validation cost, negligible at this scale |
| **LLM schemas written early** | "Every output is structured" is designed in, not retrofitted | Unused code until Phase 2 |
| **`applied` boolean in schema** | Human gate is structural, not a convention | — |

---

## 13. Bugs found during Phase 0

All three were caught by running the generator against the real endpoint. This is
the return on building the fixture first.

### 13.1 `3000ms` was not being normalised

**Symptom.** Grouping by signature showed
`Upstream timeout contacting payments-service after 3000ms` with the number intact.

**Cause.** The regex was `/\b\d[\d,._]*\b/g`. In `3000ms`, the character after `0`
is `m` — both are word characters, so there is no word boundary and the trailing
`\b` never matched.

**Impact if shipped.** `after 3000ms` and `after 5000ms` would be distinct
signatures. The new-error detector would fire on ordinary timeout jitter — a
constant false-positive stream in the exact detector meant to be the most precise.

**Fix.** Dropped the trailing `\b`: `/\b\d+(?:[.,]\d+)*/g`. The leading `\b` still
protects `utf8` and `ipv4`.

### 13.2 Only error-level entries got signatures

**Symptom.** Only two signatures existed in the baseline; the 404 and 429 entries
had `error_signature = null`.

**Cause.** Ingestion used `isErrorLevel` (`error`/`fatal`), so `warn` entries were
skipped.

**Impact if shipped.** A brand-new 4xx failure pattern would be **completely
invisible** to the new-signature detector.

**Fix.** Introduced `SIGNATURE_LEVELS` (`warn`/`error`/`fatal`) and
`hasErrorSignature()`, kept separate from `ERROR_LEVELS` used for error-rate maths.
Two genuinely different questions now have two predicates.

### 13.3 The fixture was too weak to test the normaliser

**Symptom.** After fixing the above, `COUNT(DISTINCT message)` per signature was 1
— every `Order 88213 not found` was byte-identical.

**Cause.** `BASELINE_ERRORS` held fixed strings with hardcoded ids.

**Impact.** A completely broken normaliser would still pass, because there was
nothing to collapse. The test was vacuous.

**Fix.** `FailureKind.message` became `(rng: Rng) => string`, generating fresh ids
per occurrence. Distinct raw messages went from 1 to 87, and the collapse is now
genuinely demonstrated.

### 13.4 Process note: a stale server invalidated one verification run

Mid-Phase-0 a `pkill -f "tsx src/server.ts"` failed to match, because `tsx` spawns
a child node process with a different command line. The old server kept port 4000,
the new one exited with `EADDRINUSE`, and a verification run I had already reported
hit **stale pre-fix code**.

Caught by reading the background log, fixed by killing via
`lsof -ti:4000 | xargs kill -9`, and every result in this document comes from a
subsequent clean run against a freshly reset database.

---

## 14. Running and verifying

### First run

```bash
pnpm install
cp .env.example .env
pnpm db:push
pnpm backend                            # terminal 1
pnpm generate backfill --minutes 180    # terminal 2
```

### Verification queries

Health (executes a real query, so it proves the database too):

```bash
curl -s localhost:4000/health
# {"status":"ok","database":"/…/data/dev.db","logCount":47078}
```

Signature collapse — the key correctness check:

```bash
sqlite3 -header -column data/dev.db "
  SELECT error_signature AS signature,
         COUNT(*)                AS entries,
         COUNT(DISTINCT message) AS distinct_raw
  FROM logs WHERE error_signature IS NOT NULL
  GROUP BY 1 ORDER BY 2 DESC;"
```

`distinct_raw` much greater than the number of signatures is the proof
normalisation is working.

Validation behaviour:

```bash
curl -s -X POST localhost:4000/ingest -H 'content-type: application/json' -d '{
  "entries": [
    {"timestamp":"2026-07-28T12:00:00Z","service":"orders-api","level":"error","message":"real"},
    {"timestamp":"2026-07-28T12:00:00Z","level":"error","message":"no service"},
    {"timestamp":"bad","service":"orders-api","level":"info","message":"bad ts"}
  ]}'
# {"accepted":1,"rejected":2,"errors":[
#   {"index":1,"reason":"service: Invalid input: expected string, received undefined"},
#   {"index":2,"reason":"timestamp: must be an ISO-8601 string or epoch milliseconds"}]}
```

Typecheck:

```bash
pnpm typecheck        # strict TS across all three packages
```

### Reset

```bash
lsof -ti:4000 | xargs kill -9
rm -f data/dev.db*
pnpm db:push
```

---

## 15. Phase 1 — the detection pipeline

Tier 1 detection (rollup worker plus the three statistical detectors) has its own
full reference, written to the same depth as this document:

**→ [`DOCUMENTATION-PHASE-1.md`](./DOCUMENTATION-PHASE-1.md)**

In brief: six source files plus two test files under
`packages/backend/src/detection/`, split into **pure** (`stats.ts`,
`detectors.ts`, `config.ts` — no database, no clock, no I/O) and **impure**
(`rollup.ts`, `engine.ts`, `cli.ts`). That split is what allows the detection
logic to be proven with fixed inputs rather than spot-checked against a live
database.

Three detectors, each pairing a relative threshold with an absolute floor:

| Detector | Fires when | Floor stops |
|---|---|---|
| `error_rate_spike` | errors/min > `mean + 3σ` of baseline | One extra error on a quiet service |
| `latency_jump` | window p95 ≥ 3x baseline p95 (median) | 2ms → 8ms being called a 4x regression |
| `new_error_signature` | signature absent from baseline, ≥3 occurrences | A single fluke |

Verified: a healthy baseline produces **zero** anomalies; each injection scenario
fires its own detector; 27 unit tests pass against the real config. Anomalies are
written with `severity`, `summary` and `is_real_incident` left null — those belong
to Tier 2.

The Phase 1 document covers every file line by line, the statistics and why each
choice was made, a worked example with real numbers from the verification run, a
design-decisions table, and the known limitations.

---

## 16. What comes next

### Phase 2 — LLM classification

1. **Provider interface** — one contract with implementations for Gemini
   (primary), NVIDIA NIM (backup), OpenRouter (model comparison for evals),
   Ollama (offline dev loop), and a deterministic stub for tests and CI.
2. **Classifier prompt** — sample the flagged window's logs, parse the response
   into `classificationSchema`, with a parse-repair loop that feeds validation
   errors back on failure.
3. **Cost logging** — write `llm_calls` rows so the two-tier claim is a
   measurement rather than an assertion.

The anomaly rows Phase 1 produces are the input. `severity`, `summary` and
`is_real_incident` are the columns waiting to be filled.

### Later phases

- **Phase 3** — the Express orders API with a bug landed as a **real commit**, and
  the Octokit correlation agent that finds it.
- **Phase 4** — root-cause and fix agent, `applied` stays `false`.
- **Phase 5** — Next.js dashboard: timeline → click → full reasoning trace.
