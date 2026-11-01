/**
 * Chart geometry — pure, so the components stay markup.
 *
 * WHAT THIS FILE DOES
 * Turns per-minute rollups into the numbers an SVG needs: a dense minute grid
 * (missing minutes made explicit), bar rectangles, a line path with gaps where
 * there was no traffic, and a shaded band for the anomaly window. No chart
 * library: the dashboard has three dependencies and two SVG shapes do not earn
 * a fourth.
 *
 * TWO DECISIONS WORTH KNOWING
 *
 * A minute with no rollup is ZERO errors but NO latency. Zero is the true
 * error count of a silent minute; a p95 of zero would draw a cliff that never
 * happened. So the latency line breaks across the gap instead — and a dead
 * service reads, correctly, as a line that stops.
 *
 * One measure per chart. Errors and p95 are different units, and a dual-axis
 * chart invites reading a correlation off two scales someone chose. They are
 * drawn as two charts sharing an x-axis.
 */

export interface MinutePoint {
  minute: number;
  requests: number;
  errors: number;
  /** Null when the minute has no rollup — no traffic, not zero latency. */
  p95: number | null;
}

export interface RollupPoint {
  bucketStart: Date;
  requestCount: number;
  errorCount: number;
  p95Ms: number;
}

const MINUTE_MS = 60_000;

const floorMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

/** Every minute in [from, to), filled from the rollups. */
export function minuteGrid(rows: readonly RollupPoint[], from: Date, to: Date): MinutePoint[] {
  const byMinute = new Map(rows.map((row) => [floorMinute(row.bucketStart.getTime()), row]));
  const points: MinutePoint[] = [];
  for (let minute = floorMinute(from.getTime()); minute < to.getTime(); minute += MINUTE_MS) {
    const row = byMinute.get(minute);
    points.push({
      minute,
      requests: row?.requestCount ?? 0,
      errors: row?.errorCount ?? 0,
      p95: row && row.requestCount > 0 ? row.p95Ms : null,
    });
  }
  return points;
}

/** A "nice" axis maximum: 1, 2 or 5 times a power of ten, at or above `value`. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (step * power >= value) return step * power;
  }
  return 10 * power;
}

export interface Frame {
  width: number;
  height: number;
  /** Plot area insets, leaving room for axis labels. */
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Bar {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Band {
  x: number;
  width: number;
}

export interface ChartGeometry {
  bars: Bar[];
  /** SVG path; `M` starts a new segment after a gap. Empty when there is no data. */
  line: string;
  /** One per minute, full plot height — the hover hit targets. */
  columns: Band[];
  band: Band | null;
  yMax: number;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
}

/**
 * Lay out one measure over the minute grid.
 *
 * `kind: "bars"` for counts (errors), `kind: "line"` for a level (p95). The
 * window band is clipped to the plot, so a window that started before the
 * visible range still shades the part that is visible.
 */
export function layout(
  points: readonly MinutePoint[],
  measure: "errors" | "p95",
  frame: Frame,
  window: { start: Date; end: Date } | null,
): ChartGeometry {
  const plotLeft = frame.left;
  const plotRight = frame.width - frame.right;
  const plotTop = frame.top;
  const plotBottom = frame.height - frame.bottom;
  const plotWidth = Math.max(1, plotRight - plotLeft);
  const plotHeight = Math.max(1, plotBottom - plotTop);

  const count = Math.max(1, points.length);
  const step = plotWidth / count;
  const values = points.map((p) => (measure === "errors" ? p.errors : p.p95));
  const yMax = niceMax(Math.max(0, ...values.map((v) => v ?? 0)));
  const yFor = (value: number) => plotBottom - (value / yMax) * plotHeight;

  const columns = points.map((_, i) => ({ x: plotLeft + i * step, width: step }));

  const bars: Bar[] = [];
  let line = "";

  if (measure === "errors") {
    // A 2px surface gap between neighbours, but never a bar thinner than 1px.
    const gap = step > 4 ? 2 : 0;
    points.forEach((point, i) => {
      if (point.errors <= 0) return;
      const y = yFor(point.errors);
      bars.push({ x: plotLeft + i * step + gap / 2, y, width: Math.max(1, step - gap), height: plotBottom - y });
    });
  } else {
    let drawing = false;
    points.forEach((point, i) => {
      if (point.p95 === null) {
        drawing = false;
        return;
      }
      const x = (plotLeft + i * step + step / 2).toFixed(1);
      const y = yFor(point.p95).toFixed(1);
      line += `${drawing ? "L" : "M"}${x},${y}`;
      drawing = true;
    });
  }

  let band: Band | null = null;
  const first = points[0];
  if (window && first) {
    const toX = (ms: number) => plotLeft + ((ms - first.minute) / MINUTE_MS) * step;
    const x0 = Math.max(plotLeft, toX(window.start.getTime()));
    const x1 = Math.min(plotRight, toX(window.end.getTime()));
    if (x1 > x0) band = { x: x0, width: x1 - x0 };
  }

  return { bars, line, columns, band, yMax, plotLeft, plotRight, plotTop, plotBottom };
}

export const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/** Up to `max` evenly spaced tick indices, always including the first and last. */
export function tickIndices(length: number, max: number): number[] {
  if (length <= 0) return [];
  if (length <= max) return Array.from({ length }, (_, i) => i);
  const step = (length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => Math.round(i * step));
}

/**
 * The span a chart shows: some context before the window, a little after, and
 * never more than `maxMinutes` in all. A long window (a silence that lasted
 * hours) keeps its END in view, because the end is where the state is now.
 */
export function chartRange(
  windowStart: Date,
  windowEnd: Date,
  options: { beforeMinutes: number; afterMinutes: number; maxMinutes: number },
): { from: Date; to: Date } {
  const to = floorMinute(windowEnd.getTime()) + options.afterMinutes * MINUTE_MS;
  const wanted = floorMinute(windowStart.getTime()) - options.beforeMinutes * MINUTE_MS;
  const from = Math.max(wanted, to - options.maxMinutes * MINUTE_MS);
  return { from: new Date(from), to: new Date(to) };
}
