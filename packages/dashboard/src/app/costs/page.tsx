/**
 * Where the model budget went.
 *
 * WHAT IT IS FOR
 * The two-tier design makes a claim about cost: the model fires rarely, about
 * one call per incident per stage. `llm_calls` records every call, failures
 * included, so the claim can be checked rather than asserted — this page is
 * that check, plus the number an operator needs before the next run: how much
 * of today's per-model quota is already gone.
 *
 * TOKENS, NOT CURRENCY
 * Every provider in use is a free tier. A dollar column reading 0.00 would
 * imply precision that is not there, so this page counts requests and tokens.
 *
 * REQUESTS ARE COUNTED THE WAY THE PROVIDER COUNTS THEM
 * A schema repair is a second request and is charged against the daily quota
 * like the first, so "requests" here is `1 + repairs` per call. It is the same
 * arithmetic `pnpm watch --budget` enforces, so the two never disagree.
 */

import Link from "next/link";
import { getCostSummary, type UsageGroup } from "@/lib/queries";
import { DayBars } from "../charts";

export const dynamic = "force-dynamic";

/** Free-tier daily request caps we know about, per model. Shown as context, never enforced here. */
const KNOWN_DAILY_CAPS: Record<string, number> = { gemini: 20 };

const number = (n: number) => Math.round(n).toLocaleString("en-US");

function UsageTable({ rows, label }: { rows: UsageGroup[]; label: string }) {
  return (
    <table className="calls">
      <thead>
        <tr>
          <th>{label}</th>
          <th>Calls</th>
          <th>Requests</th>
          <th>Failed</th>
          <th>Tokens in / out</th>
          <th>Avg latency</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td><code className="mono">{row.key}</code></td>
            <td>{number(row.calls)}</td>
            <td>{number(row.requests)}{row.repairs > 0 ? ` (${row.repairs} repairs)` : ""}</td>
            <td style={{ color: row.failed > 0 ? "var(--critical)" : undefined }}>{number(row.failed)}</td>
            <td>{number(row.inputTokens)} / {number(row.outputTokens)}</td>
            <td>{number(row.avgLatencyMs)}ms</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function CostsPage() {
  const cost = await getCostSummary();
  const { total } = cost;
  const failureRate = total.calls > 0 ? (total.failed / total.calls) * 100 : 0;
  const neverCalled = cost.anomaliesTotal - cost.anomaliesWithCalls;

  return (
    <>
      <Link href="/" className="back">← all anomalies</Link>

      <header className="site">
        <h1>Model cost</h1>
        <p>Every model call this system has made, including the ones that failed.</p>
      </header>

      {total.calls === 0 ? (
        <div className="empty" style={{ marginTop: 28 }}>
          <h2>No model calls yet</h2>
          <p>
            Tier 1 is free and never calls a model. Calls appear here once something runs{" "}
            <code className="mono">pnpm classify</code>, <code className="mono">pnpm correlate</code>,{" "}
            <code className="mono">pnpm diagnose</code> or <code className="mono">pnpm watch --llm</code>.
          </p>
        </div>
      ) : (
        <>
          <section className="funnel">
            <div className="step">
              <div className="n">{number(total.requests)}</div>
              <div className="k">Requests</div>
              <div className="note">{number(total.calls)} calls, {number(total.repairs)} repairs</div>
            </div>
            <div className="step">
              <div className="n">{number(total.inputTokens + total.outputTokens)}</div>
              <div className="k">Tokens</div>
              <div className="note">{number(total.inputTokens)} in / {number(total.outputTokens)} out</div>
            </div>
            <div className="step">
              <div className="n">{failureRate.toFixed(0)}%</div>
              <div className="k">Failed</div>
              <div className="note">{number(total.failed)} calls spent quota and returned nothing usable</div>
            </div>
            <div className="step">
              <div className="n">{number(cost.anomaliesWithCalls)}</div>
              <div className="k">Anomalies that cost a call</div>
              <div className="note">{number(neverCalled)} of {number(cost.anomaliesTotal)} never reached a model</div>
            </div>
          </section>

          <section className="stage">
            <h2>Today</h2>
            <p className="tier">Per provider and model — free-tier quotas are per model</p>
            {cost.today.length === 0 ? (
              <p style={{ color: "var(--muted)" }}>No model requests yet today (UTC).</p>
            ) : (
              <table className="calls">
                <thead>
                  <tr><th>Provider · model</th><th>Requests today</th><th>Known free-tier cap</th></tr>
                </thead>
                <tbody>
                  {cost.today.map((row) => {
                    const cap = KNOWN_DAILY_CAPS[row.provider];
                    return (
                      <tr key={`${row.provider}|${row.model}`}>
                        <td><code className="mono">{row.provider} · {row.model}</code></td>
                        <td>{number(row.requests)}</td>
                        <td style={{ color: "var(--muted)" }}>
                          {cap === undefined
                            ? row.provider === "stub" || row.provider === "ollama"
                              ? "local — no quota"
                              : "unknown"
                            : `${cap}/day · ${Math.max(0, cap - row.requests)} left`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section className="stage">
            <h2>Over time</h2>
            <p className="tier">Hover a day for its failures</p>
            <DayBars days={cost.byDay} />
          </section>

          <section className="stage">
            <h2>By stage</h2>
            <p className="tier">One call per incident per stage is the design target</p>
            <UsageTable rows={cost.byAgent} label="Stage" />
          </section>

          <section className="stage">
            <h2>By model</h2>
            <p className="tier">Provider · model</p>
            <UsageTable rows={cost.byModel} label="Model" />
          </section>
        </>
      )}
    </>
  );
}
