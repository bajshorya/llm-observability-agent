# LLM-Powered Observability Agent — Architecture & Build Plan

A portfolio-grade GenAI project in **TypeScript / Node.js**. It ingests logs and metrics
from a running application, detects anomalies (statistically *and* semantically), correlates
them with recent code changes, and produces a plain-English **root-cause hypothesis** plus a
**suggested fix** — surfaced through a dashboard that shows the agent's full reasoning trace.

The point of the project is not "call an LLM on some logs." The point is a *system*: cheap
detection first, LLM reasoning only where it earns its cost, multi-source correlation, and a
human-confirm gate before anything is acted on. That combination is what makes it read as
senior-level engineering rather than a wrapper.

---

## 1. Why this project is worth building

- **Underused genre.** Most GenAI portfolios are chatbots or RAG-over-PDFs. An observability
  agent that reasons across logs *and* git history is distinctive.
- **Plays to your strengths.** It's a backend/systems project with an LLM reasoning layer on
  top — closer to how GenAI is actually used in production than a chat UI.
- **Demoable.** Inject a bug into a monitored app, watch the agent catch it, correlate it to
  the commit, and explain the fix. That live "aha" moment is what interviewers remember.
- **Honest engineering signals.** Using statistics for the cheap 90% and the LLM for the hard
  10% signals judgment. Reviewers notice when someone LLM-hammers everything.

---

## 2. What you need before you start

### Accounts / keys
- An LLM API key — Anthropic (Claude) or OpenAI. Structured-output support matters here.
- A GitHub personal access token (read-only, `repo` scope) for commit correlation.

### Local tooling
- Node.js 20+ and pnpm (or npm).
- Docker (optional but recommended — makes Postgres and the monitored app easy to run).
- A database: **Postgres** for the real version, or **SQLite** to move fast in early phases.

### A "monitored target" — the app you'll observe
You need *something* generating logs. Best option: reuse a project you already own so you can
inject failures at will. Your **mini-redis** or **CEX** project is ideal. If you'd rather not
touch existing code, build a tiny throwaway Express "orders API" with 3–4 endpoints — it only
needs to emit structured logs and occasionally misbehave on command.

### Libraries you'll likely use
- **Web/API:** Express or Fastify (Fastify if you want the perf/typing story).
- **DB access:** Prisma or Drizzle ORM (both TS-first; Drizzle is lighter, Prisma is friendlier).
- **LLM calls:** Vercel AI SDK *or* the raw Anthropic/OpenAI SDK.
- **Schema validation / structured output:** Zod — every LLM output is parsed into a Zod schema.
- **GitHub:** Octokit.
- **Frontend:** Next.js (App Router) + a chart lib (Recharts) for the dashboard.
- **Background work:** a simple interval/cron worker to start; BullMQ + Redis if you want a
  proper job queue later.

---

## 3. High-level architecture

```
                    ┌─────────────────────────────────────────────────┐
                    │              MONITORED TARGET APP                │
                    │   (mini-redis / CEX / throwaway orders API)      │
                    │   emits structured logs + metrics                │
                    └───────────────────────┬─────────────────────────┘
                                             │ logs (HTTP POST / file tail)
                                             ▼
     ┌──────────────────────────────────────────────────────────────────────┐
     │                        OBSERVABILITY BACKEND (Node/TS)                 │
     │                                                                        │
     │  ┌────────────┐   ┌──────────────────┐   ┌──────────────────────────┐  │
     │  │ Ingestion  │──▶│  Log/Metric      │──▶│  Detection Pipeline       │  │
     │  │ endpoint   │   │  store (Postgres)│   │  ┌────────────────────┐   │  │
     │  └────────────┘   └──────────────────┘   │  │ Tier 1: statistical│   │  │
     │                                          │  │ (error spikes,     │   │  │
     │                                          │  │  latency jumps)    │   │  │
     │                                          │  └─────────┬──────────┘   │  │
     │                                          │            │ flagged      │  │
     │                                          │            ▼ window       │  │
     │                                          │  ┌────────────────────┐   │  │
     │                                          │  │ Tier 2: LLM        │   │  │
     │                                          │  │ classification     │   │  │
     │                                          │  │ (semantic anomaly) │   │  │
     │                                          │  └────────────────────┘   │  │
     │                                          └───────────┬──────────────┘  │
     │                                                      │ anomaly created │
     │                                                      ▼                 │
     │   ┌──────────────────┐        ┌──────────────────────────────────────┐ │
     │   │ GitHub (Octokit) │◀──────▶│  Correlation Agent                   │ │
     │   │ recent commits   │        │  (match anomaly window ↔ commits)    │ │
     │   └──────────────────┘        └───────────────┬──────────────────────┘ │
     │                                               ▼                        │
     │                            ┌───────────────────────────────────────┐   │
     │                            │  Root-Cause + Fix Agent               │   │
     │                            │  (hypothesis + suggested fix, gated)  │   │
     │                            └───────────────┬───────────────────────┘   │
     └────────────────────────────────────────────┼──────────────────────────┘
                                                   │ REST / tRPC
                                                   ▼
                        ┌────────────────────────────────────────────┐
                        │        DASHBOARD (Next.js)                 │
                        │  timeline of anomalies → click one →       │
                        │  reasoning trace: logs → detection →       │
                        │  correlated commit → hypothesis → fix      │
                        └────────────────────────────────────────────┘
```

The key design idea is the **two-tier detection funnel**: statistics catch the obvious and
cheap cases with zero LLM cost; the LLM is only invoked on windows the statistical layer flags,
where semantic understanding actually adds value (a brand-new error string that isn't a spike
*yet*, a subtly changed error message, a cascade across services).

---

## 4. Component breakdown

### 4.1 Ingestion layer
- One HTTP endpoint, e.g. `POST /ingest`, accepting a batch of structured log entries.
- Alternative/companion: a file-tail collector that reads a log file and forwards lines.
- Validate every incoming entry against a Zod schema; reject malformed entries rather than
  storing garbage.
- Keep this dumb and fast — it should do nothing but validate and persist.

### 4.2 Log / metric store
- Postgres table for logs; a separate table (or rollup) for per-minute metrics
  (request count, error count, p50/p95/p99 latency per service/endpoint).
- Index on `(service, timestamp)` — every detection query is time-windowed.
- A background worker computes the per-minute metric rollups from raw logs so detection reads
  cheap aggregates, not millions of raw rows.

### 4.3 Detection pipeline

**Tier 1 — statistical (no LLM):**
- Rolling error-rate: flag when error count in the last N minutes exceeds `mean + k·stddev`
  of a trailing baseline window.
- Latency: flag when p95/p99 jumps beyond a threshold vs the trailing baseline.
- New-error-signature detection: flag error messages (normalized — strip IDs/numbers) not seen
  in the baseline window.
- Output of this tier: an "anomaly candidate" with a time window and the triggering signal(s).

**Tier 2 — LLM classification (only on candidates):**
- Take the flagged window's logs (sampled/truncated to fit context), pass to the LLM.
- Ask it to: assign a severity, describe *what* is anomalous in plain language, and decide
  whether this is a real incident or benign noise.
- Force the output into a Zod schema (`severity`, `summary`, `isRealIncident`, `affectedArea`).
- This is where you demonstrate judgment: the LLM confirms/enriches, it doesn't do the first-pass
  scanning of every log line (that would be slow and expensive).

### 4.4 Correlation agent
- On a confirmed anomaly, query GitHub (Octokit) for commits to the monitored repo in a window
  around the anomaly's start time (e.g. the preceding 30–60 min).
- Pass the anomaly summary + the candidate commits (messages + changed files + optionally diffs)
  to the LLM and ask it to rank which commit is the most likely culprit and why.
- Output schema: `suspectedCommit`, `confidence`, `reasoning`, `changedFilesImplicated`.
- This is the step that makes the project feel genuinely *agentic* — it reasons across two
  independent data sources (runtime behavior + source history).

### 4.5 Root-cause + fix agent
- Inputs: the anomaly, the LLM classification, the correlated commit + its diff.
- Output: a root-cause hypothesis and a suggested fix — expressed as a plain-English patch
  description or a proposed diff.
- **Do not auto-apply.** Keep a human-confirm gate. This is both safer and a strong interview
  talking point ("I deliberately kept a human in the loop for any write action").

### 4.6 Dashboard
- Next.js app. Main view: a timeline of anomalies (severity color-coded).
- Detail view for a single anomaly = the **reasoning trace**:
  raw logs → what the detector flagged → LLM classification → correlated commit →
  root-cause hypothesis → suggested fix.
- That trace view is your headline demo. Make it clean.

---

## 5. Data model (starting point)

```
logs
  id            uuid pk
  timestamp     timestamptz
  service       text
  level         text        -- info | warn | error | fatal
  message       text
  metadata      jsonb       -- request id, endpoint, latency_ms, status, etc.

metrics_rollup            -- per minute, per service/endpoint
  id            uuid pk
  bucket_start  timestamptz
  service       text
  endpoint      text
  request_count int
  error_count   int
  p50_ms        int
  p95_ms        int
  p99_ms        int

anomalies
  id                uuid pk
  detected_at       timestamptz
  window_start      timestamptz
  window_end        timestamptz
  trigger           jsonb      -- which statistical signal(s) fired
  severity          text       -- from LLM tier
  summary           text       -- from LLM tier
  is_real_incident  boolean
  status            text       -- open | correlated | diagnosed | dismissed | resolved

correlations
  id                uuid pk
  anomaly_id        uuid fk -> anomalies
  suspected_commit  text       -- sha
  confidence        float
  reasoning         text
  implicated_files  jsonb

hypotheses
  id                uuid pk
  anomaly_id        uuid fk -> anomalies
  root_cause        text
  suggested_fix     text
  applied           boolean default false   -- stays false; human gate
```

---

## 6. LLM design notes

- **Every LLM output is structured.** Define a Zod schema per agent and parse the response into
  it; never consume free-form text where a structured object is possible. This kills a whole
  class of bugs and is exactly what production GenAI systems do.
- **Context budgeting.** Windows can be large — sample or summarize logs before sending. Show
  you thought about token cost.
- **Separate prompts per role** (classifier, correlator, root-cause) rather than one mega-prompt.
  Cleaner, cheaper, easier to evaluate.
- **Determinism where it helps.** Low temperature for classification/correlation; you want
  repeatable judgments, not creativity.
- **Cost/latency logging.** Log tokens and latency per call. Being able to say "the LLM only
  fires on ~5% of windows, keeping cost at roughly X" is a great interview line.

---

## 7. Build plan — start, middle, end

Build in vertical slices so you always have something runnable. Resist building all of Tier 1
before you have any data flowing.

### Phase 0 — Foundations (start here)
1. Repo scaffold: monorepo or two packages (`backend`, `dashboard`). TypeScript strict mode on.
2. Stand up Postgres (Docker) and the schema via Prisma/Drizzle migrations.
3. Build the **synthetic log/metrics generator** *first*. A script that emits realistic logs for
   a fake service — steady baseline traffic, then on command injects an anomaly (error spike,
   latency jump, or a new error signature). This gives you data to develop against from day one
   and doubles as your demo driver later.
4. Build the ingestion endpoint + storage. Verify logs land in the DB.

### Phase 1 — Statistical detection (no LLM yet)
5. Metric rollup worker (raw logs → per-minute aggregates).
6. Tier-1 detectors: error-rate spike, latency jump, new-error-signature.
7. Write anomalies to the DB. Trigger a synthetic anomaly and confirm one gets created.
   *You now have a working anomaly detector with zero LLM involved — that's your honest baseline.*

### Phase 2 — LLM classification
8. Wire in the LLM SDK + a Zod-validated classifier prompt.
9. On each Tier-1 candidate, call the classifier, store severity/summary/is_real_incident.
10. Add cost/latency logging around the call.

### Phase 3 — Correlation
11. Octokit integration: fetch commits in the anomaly's time window from your monitored repo.
12. Correlation agent: rank the likely culprit commit, store the correlation + reasoning.
    (Make sure your monitored app's "injected bug" corresponds to a real commit so this has
    something true to find — great for the demo.)

### Phase 4 — Root cause + fix
13. Root-cause/fix agent: hypothesis + suggested fix from anomaly + commit diff.
14. Store it; keep `applied = false`. Human gate only.

### Phase 5 — Dashboard (end)
15. Next.js timeline of anomalies.
16. Anomaly detail = the full reasoning trace view.
17. Polish: severity colors, the click-through story, empty/loading states.

### Phase 6 — Polish & story
18. README with the architecture diagram, a GIF of the live demo, and the "why two-tier" writeup.
19. A one-command demo script: seed baseline → inject bug → watch it flow end to end.

---

## 8. Testing strategy

- **Unit-test the statistical detectors** with fixed input windows and known expected flags —
  this is deterministic and easy to prove correct.
- **Golden cases for the LLM layer:** keep a small set of labeled anomaly windows and check the
  classifier's severity/summary against expectations. This doubles as a lightweight eval harness
  (and is itself a resume-worthy detail — "I built evals for the LLM components").
- **End-to-end smoke test:** run the demo script and assert an anomaly → correlation → hypothesis
  chain gets produced.

---

## 9. Deployment (optional but nice)

- Backend: Render / Railway / Fly (you've used Render before for Idea Radar).
- Postgres: managed instance on the same platform, or Neon/Supabase.
- Dashboard: Vercel.
- Keep secrets in env vars; never commit keys.
- A live URL + the demo GIF in the README is what makes recruiters actually click.

---

## 10. Stretch goals (only after the core works)

- **Slack/Discord alerting** when a high-severity anomaly is confirmed.
- **BullMQ + Redis** job queue instead of interval polling — a real async-architecture story.
- **Multiple monitored services** with cross-service correlation ("failure in A cascaded to B").
- **Feedback loop:** let a user mark a hypothesis right/wrong; feed that back into evals.
- **A tiny eval dashboard** showing classifier accuracy over your golden set across prompt versions.

---

## 11. How to talk about it (resume + interview)

- **Resume line (draft):** "Built an LLM-powered observability agent (TypeScript/Node, Next.js,
  Postgres) that detects runtime anomalies via a two-tier statistical + LLM pipeline, correlates
  them with recent commits via the GitHub API, and generates root-cause hypotheses with a
  human-in-the-loop fix gate."
- **Talking points to rehearse:**
  - Why two tiers — cost/latency judgment, not LLM-hammering everything.
  - Structured outputs with Zod — reliability of the GenAI layer.
  - Multi-source reasoning (logs + git) — the agentic part.
  - Human-confirm gate on fixes — safety-conscious design.
  - The eval harness for the LLM components — you measure, you don't vibe-check.

---

## 12. First three things to do right now

1. Scaffold the repo (backend + dashboard, strict TS, DB migrations).
2. Write the **synthetic log generator** — baseline + on-command anomaly injection.
3. Build the ingestion endpoint and confirm logs land in Postgres.

Everything after that has data to run against, which is what keeps momentum up.
