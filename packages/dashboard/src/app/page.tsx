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
 * which is precisely the system this one is built not to be.
 */

import Link from "next/link";
import { getFunnel, listAnomalies } from "@/lib/queries";
import { formatAge, formatWindow, severityClass } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function TimelinePage() {
  const [rows, funnel] = await Promise.all([listAnomalies(), getFunnel()]);

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

      {rows.length === 0 ? (
        <div className="empty">
          <h2>Nothing detected yet</h2>
          <p>The database has no anomalies. Generate some traffic and run the detectors:</p>
          <pre>{`pnpm backend                                  # terminal 1
pnpm generate backfill --minutes 120          # terminal 2
pnpm generate inject --scenario new-error --minutes 5
pnpm detect
pnpm classify`}</pre>
          <p>This page reads the same database those commands write to.</p>
        </div>
      ) : (
        rows.map((row) => {
          const band = severityClass(row.severity, row.isRealIncident);
          const dismissed = row.isRealIncident === false;

          return (
            <Link key={row.id} href={`/anomaly/${row.id}`} className={`row ${band}`}>
              <div className="top">
                <span className="service">{row.service}</span>
                <span className={`tag sev ${band}`}>
                  {dismissed ? "dismissed" : (row.severity ?? "unclassified")}
                </span>
                <span className="tag">{formatWindow(row.windowStart, row.windowEnd)}</span>
                <span className="when">{formatAge(row.detectedAt)}</span>
              </div>

              {row.summary ? (
                <p className="summary">{row.summary}</p>
              ) : (
                <p className="pending">Not yet classified — run `pnpm classify`.</p>
              )}

              <div className="triggers">
                {row.triggers.map((trigger, i) => (
                  <span key={i} className="tag">{trigger.kind}</span>
                ))}
              </div>
            </Link>
          );
        })
      )}
    </>
  );
}
