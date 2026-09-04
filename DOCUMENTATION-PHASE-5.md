# Phase 5 — The Dashboard

Every stage before this produces rows in SQLite that only a `pnpm` command can
see. Understanding what the system does took five commands and a reading of the
evidence packet in a terminal. This phase makes it a URL.

---

## 1. What it is for

Not monitoring. There is no alerting, no refresh loop, no live tail — the
pipeline runs on demand and so does the page.

It exists to make one thing legible: **the reasoning**. Every other view of this
system is a verdict, and a verdict is the least interesting part of a system
whose whole argument is that its conclusions are checkable. The detail page is
laid out as the pipeline runs, one panel per stage, so a reader can disagree
with any stage without opening the code.

| Page | Answers |
|---|---|
| `/` | What has this found, and what did it decide? |
| `/anomaly/[id]` | Why did it decide that, and what did it cost? |

---

## 2. Next.js, against the grain of the workspace

The original proposal named a Next.js dashboard, and that is what this is. It
is worth recording that it cuts against several of this repo's conventions —
minimal dependencies, no build step between packages, Node built-ins over
libraries — and that the alternative was considered and rejected deliberately
rather than overlooked.

| Option | Verdict |
|---|---|
| Fastify + one self-contained HTML page | Zero new runtime dependencies, no build step, fits every stated convention. Rejected: not what the proposal specifies, and hand-written DOM caps what the page can become. |
| CLI writing a static HTML report | Simplest of the three and shareable as a file. Rejected: no click-through timeline, which is most of what the proposal describes. |
| **Next.js app** | **Taken.** Matches the plan and gives the timeline a real home. |

**The cost accepted:** a large dependency and a build step in a workspace that
had neither, and a `packages/dashboard` whose `node_modules` dwarfs the rest of
the repo. `transpilePackages` keeps the no-build-step-between-packages rule
intact — the dashboard consumes `@obs/backend` and `@obs/shared` as TypeScript
source, exactly as every other package does.

---

## 3. It reads the database, not an HTTP API

The backend exposes exactly one route, `POST /ingest`; everything else is a CLI.
Adding read endpoints only for the dashboard would create a second place where
"what an anomaly is" is defined, for no gain — this runs on the same machine
against the same file, in a server component.

`src/lib/queries.ts` imports the backend's Drizzle schema and client rather than
restating either. A dashboard with its own idea of what a column means is one
that will eventually disagree with the pipeline and be believed.

If the dashboard ever needs to run somewhere else, that is when a read API earns
its keep. Not before.

---

## 4. Every query is read-only, and that is a design decision

There are no buttons that classify, correlate, dismiss or re-run.

`pnpm detect`, `pnpm classify` and `pnpm correlate` are separate commands
precisely because each spends something. A "Classify" button is a page refresh
away from draining a day's free-tier quota, and the person who drains it will
not be the person who understood that clicking cost money.

The pipeline stays a set of deliberate acts. The dashboard reports what they
concluded.

---

## 5. The five panels

Each is a stage, in pipeline order.

**What the statistics found** — Tier 1's triggers, each rendered with its own
evidence: observed count against baseline, standard deviation, z-score. Plus a
short sample of raw log lines, so a reader can see the underlying data was real
without scrolling two thousand lines to reach the verdict.

`error_rate_spike` alone is an assertion. `443 errors against a baseline of
0.65/min (sd 0.9, z=97.87)` is a claim someone can argue with.

**What the model judged** — Tier 2's verdict, severity, affected area and
summary. A dismissed window says so explicitly, and says why that matters: it
tripped the same detectors a real incident would, and reading it said otherwise.

**What the model was actually shown** — the evidence packet, verbatim. Not
summarised, not prettified, and not stored: it is rebuilt at request time by
`renderContextForAnomaly`, the same pure function the pipeline calls. The page
and the model therefore cannot drift apart. This is `pnpm classify --preview
<id>` with a URL, and it is the single most useful panel — when a verdict looks
wrong the first question is always what the model was given.

**Which commit explains it** — the correlation: sha, confidence, reasoning,
implicated files. When the answer is `null` the page says declining is a real
answer rather than a failure, because a reader who does not know that will read
an empty field as a bug.

**What it cost** — every model call made about this anomaly, including the ones
that failed. A failed call spent quota and produced nothing; hiding it would
flatter exactly the number this project uses to argue for its own design.

---

## 6. Empty states are the common case

Most anomalies have not been classified, and most classified ones have not been
correlated. That is the funnel working, not a gap to apologise for.

So a stage that has not run says what it is waiting for and names the command
that would advance it, and a database with no anomalies at all gets the four
commands that would produce some. An empty dashboard should teach the pipeline,
not look broken.

---

## 7. The funnel is the headline

Across the top of the timeline: anomalies raised, how many reached a model, how
many survived judgement, how many were correlated.

That is the argument the two-tier design is made from, and it is the one number
that makes the case without reading a document. Every anomaly not in
`classified` is a model call that never happened; every dismissed one is a
correlation that never happened.

Dismissed rows stay in the timeline for the same reason. They are the evidence
that the expensive tier does something — a dashboard that hid them would show a
system that only ever agrees with its own statistics, which is precisely the
system this one is built not to be.

---

## 8. Two version constraints worth knowing

**Next 15 does not work here.** It transpiles a TypeScript config using the
workspace's own `typescript`, and this workspace is on TypeScript 7 — the native
rewrite, whose API no longer exposes the `ts.sys` surface Next 15 reaches for.
The failure is a crash inside Next that names neither cause. Next 16.2.11+
supports TypeScript 7; the dashboard is pinned above that.

**The config is `.mjs`, not `.ts`**, which sidesteps that transpile step
entirely. It is six lines and loses nothing by being untyped.

**`agentRules: false`** stops Next writing its own `AGENTS.md` and `CLAUDE.md`
into the package. This repo already has a `CLAUDE.md` governing the workspace,
and a second one describing only the dashboard would be worse than none — it is
the file an agent reads first, and it would be the wrong file.

---

## 9. Running it

```bash
pnpm dashboard        # localhost:3000, reads DATABASE_URL like every other command
```

It reads whatever `DATABASE_URL` points at, so a scratch database works:

```bash
DATABASE_URL="file:.tmp/demo.db" pnpm dashboard
```

For a live demo with commits in the correlation window, the fixture has to
overlap the generated traffic:

```bash
bash scripts/build-fixture-repo.sh --anchor now
```

Without it the packet correctly reports zero candidates — which is honest, and a
weak demonstration.

---

## 10. Verified behaviour

`pnpm typecheck` clean across all four packages, 162 tests pass, `next build`
succeeds. Checked against a seeded database:

- timeline renders the funnel and one classified, correlated anomaly
- the detail page renders all five panels
- the evidence packet appears verbatim
- the cost table lists failed calls alongside successful ones
- an unknown id returns 404
- an empty database renders the guidance state rather than a blank page

---

## 11. Known limitations

- **No auto-refresh.** The page is server-rendered per request and shows what
  was in the database when you loaded it.
- **No pagination.** The timeline caps at 100 anomalies, newest first.
- **No filtering or search.** With a single service and a demo-sized database
  neither earns its complexity yet; both are obvious increments.
- **No correlation history.** One anomaly can have several correlation rows if
  it was re-run against different providers; the page shows the newest.
- **Single service throughout.** Everything in this system is per-service, and
  the dashboard inherits that.
- **Not authenticated.** It reads a local SQLite file and binds to localhost.
  Anything else would need a real answer to who is allowed to see incident data.
