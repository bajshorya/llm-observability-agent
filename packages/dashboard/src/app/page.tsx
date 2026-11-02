/**
 * The timeline — every anomaly Tier 1 raised, newest first.
 *
 * WHAT IT IS FOR
 * One screen that answers "what has this system found, and what did it decide".
 * The funnel across the top is the argument the two-tier design is made from:
 * anomalies raised, how many reached a model, how many survived judgement. Each
 * number that does not carry forward is a model call that never happened.
 *
 * WHY DISMISSED ROWS ARE STILL SHOWN
 * They are the evidence that the expensive tier is doing something. A dashboard
 * that hid them would show a system that only ever agrees with its statistics,
 * which is precisely the system this one is built not to be. A filter can hide
 * them on request; the default never does.
 *
 * FILTERS ARE A GET FORM
 * Service, verdict, severity, status, time range and free text, all in the
 * query string. No client JavaScript, and a filtered view is a shareable link.
 * The funnel deliberately ignores the filters: it describes the whole system,
 * and a funnel of a filtered subset would argue something else.
 *
 * EACH ROW CARRIES A SPARKLINE
 * Errors per minute around the window, with the window shaded — enough to see
 * the shape (a cliff, a ramp, a blip) before opening the row.
 */

import Link from "next/link";
import { anomalyStatuses, severities } from "@obs/shared";
import { chartRange, minuteGrid } from "@/lib/chart";
import { isFiltered, parseFilters, sinceOptions, verdicts } from "@/lib/filters";
import { formatAge, formatWindow, severityClass } from "@/lib/format";
import { getFunnel, getSeries, listAnomalies, listServices } from "@/lib/queries";
import { Sparkline } from "./charts";

export const dynamic = "force-dynamic";

const verdictLabels: Record<(typeof verdicts)[number], string> = {
  real: "real incidents",
  dismissed: "dismissed",
  unclassified: "not yet classified",
  silent: "service went silent",
  injection: "prompt injection suspected",
};

const sinceLabels: Record<keyof typeof sinceOptions, string> = {
  "1h": "last hour",
  "24h": "last 24 hours",
  "7d": "last 7 days",
  all: "all time",
};

export default async function TimelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = parseFilters(await searchParams);
  const [rows, funnel, services] = await Promise.all([listAnomalies(filters), getFunnel(), listServices()]);

  const series = await Promise.all(
    rows.map(async (row) => {
      const { from, to } = chartRange(row.windowStart, row.windowEnd, {
        beforeMinutes: 45,
        afterMinutes: 10,
        maxMinutes: 120,
      });
      return minuteGrid(await getSeries(row.service, from, to), from, to);
    }),
  );

  const filtered = isFiltered(filters);

  return (
    <>
      <header className="site">
        <h1>Observability Agent</h1>
        <p>Cheap statistics detect; a model reads only what they flagged; commits explain what survives.</p>
      </header>

      <section className="funnel">
        <div className="step">
          <div className="n">{funnel.anomalies}</div>
          <div className="k">Anomalies</div>
          <div className="note">Tier 1, free</div>
        </div>
        <div className="step">
          <div className="n">{funnel.classified}</div>
          <div className="k">Classified</div>
          <div className="note">{funnel.anomalies - funnel.classified} never reached a model</div>
        </div>
        <div className="step">
          <div className="n">{funnel.realIncidents}</div>
          <div className="k">Real incidents</div>
          <div className="note">{funnel.dismissed} dismissed as benign</div>
        </div>
        <div className="step">
          <div className="n">{funnel.correlated}</div>
          <div className="k">Correlated</div>
          <div className="note">{funnel.attributed} named a commit</div>
        </div>
        <div className="step">
          <div className="n">{funnel.diagnosed}</div>
          <div className="k">Diagnosed</div>
          <div className="note">0 applied — human gate</div>
        </div>
      </section>

      {funnel.anomalies > 0 && (
        <form className="filters" method="get" action="/">
          <label>
            <span>Service</span>
            <select name="service" defaultValue={filters.service ?? ""}>
              <option value="">all</option>
              {services.map((service) => (
                <option key={service} value={service}>{service}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Verdict</span>
            <select name="verdict" defaultValue={filters.verdict ?? ""}>
              <option value="">any</option>
              {verdicts.map((v) => (
                <option key={v} value={v}>{verdictLabels[v]}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Severity</span>
            <select name="severity" defaultValue={filters.severity ?? ""}>
              <option value="">any</option>
              {severities.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Status</span>
            <select name="status" defaultValue={filters.status ?? ""}>
              <option value="">any</option>
              {anomalyStatuses.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Last fired</span>
            <select name="since" defaultValue={filters.since}>
              {(Object.keys(sinceOptions) as (keyof typeof sinceOptions)[]).map((key) => (
                <option key={key} value={key}>{sinceLabels[key]}</option>
              ))}
            </select>
          </label>
          <label className="grow">
            <span>Search</span>
            <input type="search" name="q" defaultValue={filters.q ?? ""} placeholder="summary, service or id" />
          </label>
          <div className="actions">
            <button type="submit">Apply</button>
            {filtered && <Link href="/">Clear</Link>}
          </div>
        </form>
      )}

      {funnel.anomalies === 0 ? (
        <div className="empty">
          <h2>Nothing detected yet</h2>
          <p>The database has no anomalies. Send it logs and run detection:</p>
          <pre>{`pnpm backend                                  # terminal 1
pnpm generate backfill --minutes 120          # terminal 2
pnpm generate inject --scenario new-error --minutes 5
pnpm watch --once --classify                  # detect, classify, alert`}</pre>
          <p>
            From a real service, use <code className="mono">@obs/client</code> — see the README. This page
            reads the same database those commands write to.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <h2>No anomalies match these filters</h2>
          <p>
            <Link href="/">Clear the filters</Link> to see all {funnel.anomalies}.
          </p>
        </div>
      ) : (
        <>
          {filtered && (
            <p className="count">
              {rows.length === 100 ? "Newest 100" : rows.length} matching of {funnel.anomalies}
            </p>
          )}
          {rows.map((row, index) => {
            const band = severityClass(row.severity, row.isRealIncident);
            const dismissed = row.isRealIncident === false;
            const silentOnly = row.triggers.every((trigger) => trigger.kind === "service_silent");

            return (
              <Link key={row.id} href={`/anomaly/${row.id}`} className={`row ${band}`}>
                <div className="top">
                  <span className="service">{row.service}</span>
                  <span className={`tag sev ${band}`}>
                    {dismissed ? "dismissed" : (row.severity ?? "unclassified")}
                  </span>
                  {row.injectionSuspected && (
                    <span className="tag sev critical" title="Log text in this window is addressed to the classifier">
                      injection?
                    </span>
                  )}
                  <span className="tag">{formatWindow(row.windowStart, row.windowEnd)}</span>
                  <span className="when" title="When Tier 1 last fired on it. The window shows when it began.">
                    last fired {formatAge(row.detectedAt)}
                  </span>
                </div>

                <div className="body">
                  <div className="text">
                    {row.summary ? (
                      <p className="summary">{row.summary}</p>
                    ) : silentOnly ? (
                      <p className="pending">
                        Service stopped logging. Nothing to read, so no model is asked — alerted from Tier 1.
                      </p>
                    ) : (
                      <p className="pending">Not yet classified — run `pnpm classify`.</p>
                    )}

                    <div className="triggers">
                      {row.triggers.map((trigger, i) => (
                        <span key={i} className="tag">{trigger.kind}</span>
                      ))}
                    </div>
                  </div>
                  <Sparkline points={series[index] ?? []} window={{ start: row.windowStart, end: row.windowEnd }} />
                </div>
              </Link>
            );
          })}
        </>
      )}
    </>
  );
}
