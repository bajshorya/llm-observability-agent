/**
 * One anomaly, as a reasoning trace.
 *
 * WHAT THIS PAGE IS FOR, AND WHY IT IS THE POINT OF PHASE 5
 * Every other view of this system is a verdict. This one is the argument: what
 * the statistics measured, what the model was actually shown, what it concluded,
 * which commit it blamed and on what grounds, and what the whole thing cost.
 *
 * It is laid out as the pipeline runs, top to bottom, one panel per stage. A
 * reader should be able to disagree with any stage without reading the code —
 * which is the standard the documents hold themselves to, applied to the UI.
 *
 * THE EVIDENCE PACKET IS REPRODUCED VERBATIM
 * Not summarised, not prettified. It is the exact string sent to the model,
 * rendered by the same pure function the pipeline uses, so what the page shows
 * and what the model saw cannot drift apart. `pnpm classify --preview <id>`
 * prints the same text; this is that command with a URL.
 *
 * That panel is the single most useful thing here. When a verdict looks wrong
 * the first question is always what the model was given, and this answers it
 * without spending a call.
 *
 * STAGES THAT HAVE NOT RUN SAY SO
 * An anomaly with no classification is not an error state — it is an anomaly
 * Tier 1 raised and nobody has paid to judge yet, which is the normal condition
 * of most rows and the entire point of the funnel. Each panel names the command
 * that would advance it.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { renderContextForAnomaly } from "@obs/backend/src/classification/classify";
import {
  getAnomaly,
  getCorrelation,
  getHypothesis,
  getLlmCalls,
  getWindowSample,
} from "@/lib/queries";
import { describeTrigger, formatAge, formatWindow, severityClass, tokens } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AnomalyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const anomaly = await getAnomaly(id);
  if (!anomaly) notFound();

  const [correlation, hypothesis, calls, sample, rendered] = await Promise.all([
    getCorrelation(anomaly.id),
    getHypothesis(anomaly.id),
    getLlmCalls(anomaly.id),
    getWindowSample(anomaly.service, anomaly.windowStart, anomaly.windowEnd),
    // Rebuilt from the same pure renderer the pipeline uses, so the page cannot
    // show a packet the model never saw.
    renderContextForAnomaly(anomaly.id).catch(() => null),
  ]);

  const band = severityClass(anomaly.severity, anomaly.isRealIncident);
  const dismissed = anomaly.isRealIncident === false;

  return (
    <>
      <Link href="/" className="back">← all anomalies</Link>

      <header className="site">
        <h1>{anomaly.service}</h1>
        <p>
          {formatWindow(anomaly.windowStart, anomaly.windowEnd)} · detected {formatAge(anomaly.detectedAt)} ·{" "}
          <code className="mono">{anomaly.id.slice(0, 8)}</code>
        </p>
      </header>

      {/* ---- Tier 1 --------------------------------------------------------- */}
      <section className="stage">
        <h2>What the statistics found</h2>
        <p className="tier">Tier 1 · no model, no cost</p>

        {anomaly.triggers.map((trigger, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            <span className="tag">{trigger.kind}</span>{" "}
            <span style={{ fontSize: 14 }}>{describeTrigger(trigger)}</span>
          </div>
        ))}

        {sample.length > 0 && (
          <>
            <h3>Raw lines from the window</h3>
            <pre className="packet">
              {sample
                .map(
                  (line) =>
                    `${line.timestamp.toISOString().slice(11, 19)}  ${line.level.toUpperCase().padEnd(5)} ` +
                    `${(line.endpoint ?? "").padEnd(22)} ${line.statusCode ?? ""}  ${line.message}`,
                )
                .join("\n")}
            </pre>
          </>
        )}
      </section>

      {/* ---- Tier 2 --------------------------------------------------------- */}
      <section className="stage">
        <h2>What the model judged</h2>
        <p className="tier">Tier 2 · one call per incident</p>

        {anomaly.severity === null ? (
          <p style={{ color: "var(--muted)" }}>
            Not classified. Tier 1 raised this window and no model has been asked about it —
            run <code className="mono">pnpm classify</code>.
          </p>
        ) : (
          <dl className="facts">
            <dt>Verdict</dt>
            <dd>
              <span className={`tag sev ${band}`}>{dismissed ? "dismissed as benign" : "real incident"}</span>
            </dd>
            <dt>Severity</dt>
            <dd>{anomaly.severity}</dd>
            <dt>Affected area</dt>
            <dd>{anomaly.affectedArea ?? "unknown"}</dd>
            <dt>Summary</dt>
            <dd>{anomaly.summary}</dd>
          </dl>
        )}

        {dismissed && (
          <p style={{ color: "var(--muted)", marginTop: 14, fontSize: 14 }}>
            This window tripped the same detectors a real incident would. Reading it said otherwise,
            so it was never correlated — that saved call is what the two-tier design is for.
          </p>
        )}
      </section>

      {/* ---- the packet ------------------------------------------------------ */}
      <section className="stage">
        <h2>What the model was actually shown</h2>
        <p className="tier">The evidence packet, verbatim</p>

        {rendered ? (
          <pre className="packet">{rendered.context}</pre>
        ) : (
          <p style={{ color: "var(--muted)" }}>
            The packet could not be rebuilt — the underlying logs for this window may have been
            pruned.
          </p>
        )}
      </section>

      {/* ---- Phase 3 --------------------------------------------------------- */}
      <section className="stage">
        <h2>Which commit explains it</h2>
        <p className="tier">Phase 3 · correlation</p>

        {correlation === null ? (
          <p style={{ color: "var(--muted)" }}>
            {dismissed
              ? "Not correlated, and correctly so — benign windows never reach this stage."
              : "Not correlated yet — run `pnpm correlate`."}
          </p>
        ) : (
          <dl className="facts">
            <dt>Suspected commit</dt>
            <dd>
              {correlation.suspectedCommitSha ? (
                <code className="mono">{correlation.suspectedCommitSha.slice(0, 12)}</code>
              ) : (
                <em>none — no candidate commit explains this</em>
              )}
            </dd>
            <dt>Confidence</dt>
            <dd>{correlation.confidence.toFixed(2)}</dd>
            <dt>Reasoning</dt>
            <dd>{correlation.reasoning}</dd>
            {correlation.implicatedFiles.length > 0 && (
              <>
                <dt>Files implicated</dt>
                <dd>
                  {correlation.implicatedFiles.map((file) => (
                    <div key={file}><code className="mono">{file}</code></div>
                  ))}
                </dd>
              </>
            )}
          </dl>
        )}

        {correlation?.suspectedCommitSha === null && (
          <p style={{ color: "var(--muted)", marginTop: 14, fontSize: 14 }}>
            Declining is a real answer here, not a failure. Most incidents are not caused by a
            recent deploy, and a model with no way to say so invents a culprit.
          </p>
        )}
      </section>

      {/* ---- Phase 4 --------------------------------------------------------- */}
      <section className="stage">
        <h2>Why it broke, and what to change</h2>
        <p className="tier">Phase 4 · root cause · nothing is applied</p>

        {hypothesis === null ? (
          <p style={{ color: "var(--muted)" }}>
            {correlation?.suspectedCommitSha
              ? "Not diagnosed yet — run `pnpm diagnose`."
              : "Not diagnosed. This stage reads the blamed commit's diff, and no commit was named."}
          </p>
        ) : (
          <>
            {!hypothesis.explainsTheFailure && (
              <p style={{ color: "var(--high)", marginTop: 0, fontSize: 14 }}>
                This stage <strong>disagrees</strong> with the correlation above: the diff it read
                does not account for the symptoms. That disagreement is the finding.
              </p>
            )}

            <dl className="facts">
              <dt>Root cause</dt>
              <dd>{hypothesis.rootCause}</dd>
              <dt>Suggested fix</dt>
              <dd>{hypothesis.suggestedFix}</dd>
              <dt>Confidence</dt>
              <dd>{hypothesis.confidence.toFixed(2)}</dd>
              <dt>Applied</dt>
              <dd>
                <span className="tag">{hypothesis.applied ? "applied" : "no — human gate"}</span>
              </dd>
            </dl>

            <p style={{ color: "var(--muted)", marginTop: 14, fontSize: 14 }}>
              Nothing here has been applied, and no code in this repository can apply it. The
              agent diagnoses; a human decides.
            </p>
          </>
        )}
      </section>

      {/* ---- cost ------------------------------------------------------------ */}
      <section className="stage">
        <h2>What it cost</h2>
        <p className="tier">Every model call made about this anomaly</p>

        {calls.length === 0 ? (
          <p style={{ color: "var(--muted)" }}>No model has been called about this window.</p>
        ) : (
          <table className="calls">
            <thead>
              <tr>
                <th>Stage</th><th>Model</th><th>Tokens</th><th>Latency</th><th>Repairs</th><th></th>
              </tr>
            </thead>
            <tbody>
              {calls.map((call, i) => (
                <tr key={i}>
                  <td>{call.agent}</td>
                  <td><code className="mono">{call.model}</code></td>
                  <td>{tokens(call.inputTokens, call.outputTokens)}</td>
                  <td>{call.latencyMs}ms</td>
                  <td>{call.repairAttempts}</td>
                  <td style={{ color: call.succeeded ? "var(--low)" : "var(--critical)" }}>
                    {call.succeeded ? "ok" : "failed"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
