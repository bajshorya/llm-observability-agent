/**
 * The two chart shapes the dashboard uses, as server-rendered SVG.
 *
 * No client JavaScript: hover is a native SVG `<title>` on a full-height hit
 * column per minute, which every browser shows as a tooltip. That keeps the
 * dashboard a set of server components that only read — the property the
 * project guards — and costs nothing to ship.
 *
 * Colour: one series per chart, in `--series`, which is NOT a severity colour.
 * Severity reds and ambers are status, and status colours are reserved for
 * status; an error bar painted red would claim a verdict the statistics have
 * not made. The anomaly window is a neutral wash, labelled in text.
 */

import { hhmm, layout, niceMax, tickIndices, type MinutePoint } from "@/lib/chart";

interface WindowRange {
  start: Date;
  end: Date;
}

/**
 * Centre a tick label under its column, except at the two ends, where a
 * centred label would hang off the plot and be clipped by the SVG edge.
 */
function edgeAnchor(index: number, length: number, centre: number, left: number, right: number) {
  if (index === 0) return { x: left, textAnchor: "start" as const };
  if (index === length - 1) return { x: right, textAnchor: "end" as const };
  return { x: centre, textAnchor: "middle" as const };
}

function tooltip(point: MinutePoint): string {
  const p95 = point.p95 === null ? "no traffic" : `p95 ${point.p95} ms`;
  return `${hhmm(point.minute)}Z · ${point.requests} requests · ${point.errors} errors · ${p95}`;
}

/** Errors per minute around the window — the timeline row's glance. */
export function Sparkline({ points, window }: { points: MinutePoint[]; window: WindowRange }) {
  const frame = { width: 160, height: 34, left: 0, right: 0, top: 2, bottom: 2 };
  const g = layout(points, "errors", frame, window);
  const peak = Math.max(0, ...points.map((p) => p.errors));

  return (
    <svg
      className="spark"
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      width={frame.width}
      height={frame.height}
      role="img"
      aria-label={`Errors per minute, peak ${peak}`}
    >
      <title>{`Errors per minute around the window — peak ${peak}/min`}</title>
      {g.band && <rect className="band" x={g.band.x} y={0} width={g.band.width} height={frame.height} />}
      <line className="axis" x1={0} x2={frame.width} y1={g.plotBottom} y2={g.plotBottom} />
      {g.bars.map((bar, i) => (
        <rect key={i} className="mark" x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={1} />
      ))}
    </svg>
  );
}

/** One measure, full width, with axes, the window band and per-minute hover. */
export function MetricChart({
  points,
  measure,
  window,
  title,
}: {
  points: MinutePoint[];
  measure: "errors" | "p95";
  window: WindowRange;
  title: string;
}) {
  const frame = { width: 900, height: 150, left: 44, right: 8, top: 18, bottom: 22 };
  const g = layout(points, measure, frame, window);
  const ticks = tickIndices(points.length, 7);
  const unit = measure === "errors" ? "" : " ms";

  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${frame.width} ${frame.height}`} role="img" aria-label={title}>
        {g.band && (
          <>
            <rect className="band" x={g.band.x} y={g.plotTop} width={g.band.width} height={g.plotBottom - g.plotTop} />
            <text className="label" x={g.band.x + 4} y={g.plotTop - 5}>anomaly window</text>
          </>
        )}

        {/* Recessive grid: the top line and the baseline, nothing between. */}
        <line className="grid" x1={g.plotLeft} x2={g.plotRight} y1={g.plotTop} y2={g.plotTop} />
        <line className="axis" x1={g.plotLeft} x2={g.plotRight} y1={g.plotBottom} y2={g.plotBottom} />
        <text className="label" x={g.plotLeft - 6} y={g.plotTop + 4} textAnchor="end">{`${g.yMax}${unit}`}</text>
        <text className="label" x={g.plotLeft - 6} y={g.plotBottom + 4} textAnchor="end">0</text>

        {ticks.map((i) => {
          const column = g.columns[i];
          const point = points[i];
          if (!column || !point) return null;
          return (
            <text key={i} className="label" y={frame.height - 6} {...edgeAnchor(i, points.length, column.x + column.width / 2, g.plotLeft, g.plotRight)}>
              {hhmm(point.minute)}
            </text>
          );
        })}

        {measure === "errors" ? (
          g.bars.map((bar, i) => (
            <rect key={i} className="mark" x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={Math.min(2, bar.width / 2)} />
          ))
        ) : (
          <path className="line" d={g.line} />
        )}

        {/* Hit targets wider than the marks: the whole minute column. */}
        {g.columns.map((column, i) => {
          const point = points[i];
          if (!point) return null;
          return (
            <rect key={i} className="hit" x={column.x} y={g.plotTop} width={column.width} height={g.plotBottom - g.plotTop}>
              <title>{tooltip(point)}</title>
            </rect>
          );
        })}
      </svg>
    </figure>
  );
}

/** The same numbers as a table — for screen readers, and for anyone who wants exact values. */
export function MinuteTable({ points, window }: { points: MinutePoint[]; window: WindowRange }) {
  return (
    <details className="minutes">
      <summary>Show as table</summary>
      <table className="calls">
        <thead>
          <tr>
            <th>Minute (UTC)</th>
            <th>Requests</th>
            <th>Errors</th>
            <th>p95</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {points.map((point) => {
            const inWindow = point.minute >= window.start.getTime() && point.minute < window.end.getTime();
            return (
              <tr key={point.minute}>
                <td>{hhmm(point.minute)}</td>
                <td>{point.requests}</td>
                <td>{point.errors}</td>
                <td>{point.p95 === null ? "—" : `${point.p95} ms`}</td>
                <td style={{ color: "var(--muted)" }}>{inWindow ? "window" : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}

/** Model requests per UTC day. One series; failures are in the tooltip and the table. */
export function DayBars({ days }: { days: { day: string; requests: number; failed: number }[] }) {
  const frame = { width: 900, height: 160, left: 44, right: 8, top: 14, bottom: 22 };
  const plotLeft = frame.left;
  const plotRight = frame.width - frame.right;
  const plotTop = frame.top;
  const plotBottom = frame.height - frame.bottom;
  const step = (plotRight - plotLeft) / Math.max(1, days.length);
  const yMax = niceMax(Math.max(0, ...days.map((d) => d.requests)));
  const ticks = tickIndices(days.length, 7);

  return (
    <figure className="chart">
      <figcaption>Model requests per day (UTC), last {days.length} days</figcaption>
      <svg viewBox={`0 0 ${frame.width} ${frame.height}`} role="img" aria-label="Model requests per day">
        <line className="grid" x1={plotLeft} x2={plotRight} y1={plotTop} y2={plotTop} />
        <line className="axis" x1={plotLeft} x2={plotRight} y1={plotBottom} y2={plotBottom} />
        <text className="label" x={plotLeft - 6} y={plotTop + 4} textAnchor="end">{yMax}</text>
        <text className="label" x={plotLeft - 6} y={plotBottom + 4} textAnchor="end">0</text>

        {days.map((d, i) => {
          const x = plotLeft + i * step;
          const height = (d.requests / yMax) * (plotBottom - plotTop);
          const width = Math.max(1, step - 6);
          return (
            <g key={d.day}>
              {d.requests > 0 && (
                <rect className="mark" x={x + 3} y={plotBottom - height} width={width} height={height} rx={Math.min(4, width / 2)} />
              )}
              <rect className="hit" x={x} y={plotTop} width={step} height={plotBottom - plotTop}>
                <title>{`${d.day} · ${d.requests} requests · ${d.failed} failed`}</title>
              </rect>
            </g>
          );
        })}

        {ticks.map((i) => {
          const d = days[i];
          if (!d) return null;
          return (
            <text key={d.day} className="label" y={frame.height - 6} {...edgeAnchor(i, days.length, plotLeft + i * step + step / 2, plotLeft, plotRight)}>
              {d.day.slice(5)}
            </text>
          );
        })}
      </svg>
    </figure>
  );
}
