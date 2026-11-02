/**
 * `@obs/client` — send a real application's logs to `POST /ingest`.
 *
 * WHAT THIS FILE DOES
 * Buffers log entries in memory and posts them in batches, on a timer and when
 * a batch fills. It is the piece that turns "an ingestion endpoint" into
 * something a real service can point at in three lines:
 *
 *     const obs = createObsClient({
 *       url: "http://localhost:4000/ingest",
 *       service: "orders-api",
 *       apiKey: process.env.INGEST_API_KEY,   // when the backend requires one
 *     });
 *     obs.error("Payment declined", { endpoint: "/checkout", statusCode: 502 });
 *     process.on("SIGTERM", () => obs.close());
 *
 * THE RULE IT IS BUILT AROUND: NEVER HURT THE HOST
 * A monitoring client that throws into the application, blocks a request, or
 * grows memory without bound has caused the incident it was meant to report.
 * So:
 *
 *   - every public method is synchronous and never throws; `log()` enqueues
 *   - the queue is bounded; when full, the OLDEST entries are dropped and
 *     counted — recent logs are the ones that explain what is happening now
 *   - the flush timer is `unref()`d, so it never holds a process open
 *   - failures go to `onError` (default: one `console.warn`), never upward
 *
 * VALIDATED HERE, AS WELL AS AT THE SERVER
 * Entries are checked against the same `logEntrySchema` the backend uses
 * before they are queued. An invalid entry is dropped at the call site with a
 * reason, rather than costing a round trip to learn the same thing — and the
 * shared schema means client and server cannot disagree about what is valid.
 *
 * DELIVERY
 * At most one POST in flight, each batch carrying an `Idempotency-Key` that is
 * reused on its retries, so a retry after a lost response is not stored twice. 5xx, 429 and network errors are retried with
 * exponential backoff (`maxRetries`, default 2) and the batch is then dropped
 * and reported; holding it forever is how a client's memory grows during the
 * very outage it is meant to describe. A 400 is not retried — the server has
 * already said the batch is malformed. 207 is success with per-entry
 * rejections, which are counted.
 *
 * WHAT IT DOES NOT DO
 * No disk spool: logs queued when the process dies are lost. `close()` on
 * shutdown flushes what is queued, which covers the common case. A spool is the
 * next step if a service cannot tolerate that, and it is a real cost — files,
 * rotation, recovery — so it is not here by default.
 */

import { logEntrySchema, MAX_BATCH_SIZE, type LogLevel, type LogMetadata } from "@obs/shared";
import { templatePath } from "./path";

export interface ObsClientOptions {
  /** The ingestion endpoint, e.g. `http://localhost:4000/ingest`. */
  url: string;
  /** Stamped on every entry. Detection runs per service. */
  service: string;
  /** Entries per POST. Capped at the server's limit. Default 200. */
  batchSize?: number;
  /** How often a partial batch is sent. Default 2000 ms. */
  flushIntervalMs?: number;
  /** Bound on queued entries; oldest are dropped beyond it. Default 10 000. */
  maxQueueSize?: number;
  /** Retries per batch on 5xx/429/network errors. Default 2. */
  maxRetries?: number;
  /** Base backoff between retries, doubled each time. Default 500 ms. */
  retryBaseMs?: number;
  /** The backend's `INGEST_API_KEY`, sent as `Authorization: Bearer`. Empty means none. */
  apiKey?: string | undefined;
  /** Extra request headers, e.g. for a proxy in front of ingest. */
  headers?: Record<string, string>;
  /** Called on dropped entries and failed batches. Must not throw. */
  onError?: (error: Error) => void;
  /** Injectable for tests and for runtimes without a global fetch. */
  fetch?: typeof fetch;
  /** Injectable clock. */
  now?: () => Date;
}

export interface RequestLog {
  method: string;
  /** Prefer the route TEMPLATE (`/orders/:id`); a raw path is templated for you. */
  endpoint: string;
  statusCode: number;
  latencyMs: number;
  requestId?: string;
  /** Overrides the default `METHOD /path STATUS` message, e.g. with an error text. */
  message?: string;
  metadata?: LogMetadata;
}

export interface ObsClientStats {
  queued: number;
  /** Accepted by the server. */
  sent: number;
  /** Rejected by the server, per entry (207) or per batch (400). */
  rejected: number;
  /** Never sent: invalid at the call site, queue overflow, or retries exhausted. */
  dropped: number;
}

export interface ObsClient {
  log(level: LogLevel, message: string, metadata?: LogMetadata): void;
  info(message: string, metadata?: LogMetadata): void;
  warn(message: string, metadata?: LogMetadata): void;
  error(message: string, metadata?: LogMetadata): void;
  fatal(message: string, metadata?: LogMetadata): void;
  /** One HTTP request. Level from status: 5xx error, 4xx warn, else info. */
  request(entry: RequestLog): void;
  /** Send everything queued now. Resolves when the queue is empty or delivery failed. */
  flush(): Promise<void>;
  /** Flush, then stop the timer. Further logs are dropped. */
  close(): Promise<void>;
  stats(): ObsClientStats;
}

interface QueuedEntry {
  timestamp: string;
  service: string;
  level: LogLevel;
  message: string;
  metadata: LogMetadata;
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;

/** Level from status code, the convention the generator and detectors assume. */
export function levelForStatus(statusCode: number): LogLevel {
  if (statusCode >= 500) return "error";
  if (statusCode >= 400) return "warn";
  return "info";
}

export function createObsClient(options: ObsClientOptions): ObsClient {
  const batchSize = Math.min(Math.max(1, options.batchSize ?? 200), MAX_BATCH_SIZE);
  const maxQueueSize = Math.max(batchSize, options.maxQueueSize ?? 10_000);
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const retryBaseMs = options.retryBaseMs ?? 500;
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const onError =
    options.onError ??
    ((error: Error) => {
      console.warn(`[obs-client] ${error.message}`);
    });

  const queue: QueuedEntry[] = [];
  const counters = { sent: 0, rejected: 0, dropped: 0 };
  let inFlight: Promise<void> | null = null;
  let closed = false;

  const report = (message: string) => {
    try {
      onError(new Error(message));
    } catch {
      // onError is caller code; it must not be able to break logging.
    }
  };

  const timer = setInterval(() => {
    void flush();
  }, options.flushIntervalMs ?? 2000);
  timer.unref?.();

  function enqueue(level: LogLevel, message: string, metadata: LogMetadata = {}): void {
    if (closed) {
      counters.dropped += 1;
      return;
    }

    const entry: QueuedEntry = {
      timestamp: now().toISOString(),
      service: options.service,
      level,
      message,
      metadata,
    };

    const parsed = logEntrySchema.safeParse(entry);
    if (!parsed.success) {
      counters.dropped += 1;
      const issue = parsed.error.issues[0];
      report(`dropped invalid log entry: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid"}`);
      return;
    }

    queue.push(entry);
    if (queue.length > maxQueueSize) {
      const overflow = queue.length - maxQueueSize;
      queue.splice(0, overflow);
      counters.dropped += overflow;
      report(`queue full (${maxQueueSize}); dropped ${overflow} oldest entr${overflow === 1 ? "y" : "ies"}`);
    }

    if (queue.length >= batchSize) void flush();
  }

  async function postBatch(batch: QueuedEntry[]): Promise<void> {
    /**
     * One key per batch, the same on every retry. A retry after a lost
     * response is otherwise stored twice, and doubled error lines look like
     * an error-rate spike. The server replays its first answer instead.
     */
    const idempotencyKey = globalThis.crypto.randomUUID();
    for (let attempt = 0; ; attempt += 1) {
      let status: number;
      let body = "";
      try {
        const response = await doFetch(options.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
            ...options.headers,
          },
          body: JSON.stringify({ entries: batch }),
        });
        status = response.status;
        body = await response.text().catch(() => "");
      } catch (error) {
        status = 0; // network failure: retryable
        body = error instanceof Error ? error.message : String(error);
      }

      if (status >= 200 && status < 300) {
        const result = safeJson(body);
        const accepted = typeof result?.accepted === "number" ? result.accepted : batch.length;
        const rejected = typeof result?.rejected === "number" ? result.rejected : 0;
        counters.sent += accepted;
        counters.rejected += rejected;
        if (rejected > 0) report(`server rejected ${rejected} of ${batch.length} entries (HTTP ${status})`);
        return;
      }

      const retryable = status === 0 || RETRYABLE(status);
      if (!retryable || attempt >= maxRetries) {
        if (status === 400) counters.rejected += batch.length;
        else counters.dropped += batch.length;
        report(
          `${status === 0 ? "could not reach" : `HTTP ${status} from`} ${options.url}; ` +
            `${batch.length} entries ${status === 400 ? "rejected" : "dropped"}` +
            (body ? ` — ${body.slice(0, 160)}` : ""),
        );
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, retryBaseMs * 2 ** attempt));
    }
  }

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const batch = queue.splice(0, batchSize);
      await postBatch(batch);
    }
  }

  function flush(): Promise<void> {
    if (inFlight) {
      // Chain: wait for the current send, then drain whatever arrived meanwhile.
      return inFlight.then(() => (queue.length > 0 ? flush() : undefined));
    }
    if (queue.length === 0) return Promise.resolve();

    inFlight = drain().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    log: enqueue,
    info: (message, metadata) => enqueue("info", message, metadata),
    warn: (message, metadata) => enqueue("warn", message, metadata),
    error: (message, metadata) => enqueue("error", message, metadata),
    fatal: (message, metadata) => enqueue("fatal", message, metadata),
    request(entry) {
      const endpoint = templatePath(entry.endpoint);
      const method = entry.method.toUpperCase();
      enqueue(levelForStatus(entry.statusCode), entry.message ?? `${method} ${endpoint} ${entry.statusCode}`, {
        ...entry.metadata,
        endpoint,
        method,
        statusCode: entry.statusCode,
        latencyMs: Math.max(0, Math.round(entry.latencyMs)),
        ...(entry.requestId !== undefined ? { requestId: entry.requestId } : {}),
      });
    },
    flush,
    async close() {
      await flush();
      closed = true;
      clearInterval(timer);
    },
    stats: () => ({ queued: queue.length, ...counters }),
  };
}

function safeJson(text: string): { accepted?: unknown; rejected?: unknown } | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
