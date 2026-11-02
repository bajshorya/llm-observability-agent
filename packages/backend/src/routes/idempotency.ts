/**
 * Idempotent ingest — a bounded memory of recent batch keys. No I/O.
 *
 * THE FAILURE THIS PREVENTS
 * A client posts a batch; the server inserts it; the response is lost (a
 * timeout, a dropped connection, a proxy resetting). The client cannot tell
 * that from "never arrived", so it retries — and every line is stored twice.
 * Duplicated error lines double the error count, which is precisely what the
 * error-rate detector fires on: a flaky network would manufacture incidents.
 *
 * `@obs/client` sends an `Idempotency-Key` per batch, the same on every retry.
 * The route records the response for each key, and a repeat gets the original
 * response back without inserting anything.
 *
 * THE LIMITS, STATED
 *   - in memory, per process: a restart between an attempt and its retry
 *     forgets the key. Durable keys would mean a table and a write per batch.
 *   - bounded: MAX_KEYS entries, each kept TTL_MS. Enough for a retry
 *     schedule measured in seconds; not a long-term dedupe store.
 *   - sequential retries only: two copies arriving at the same instant can
 *     both miss. The client never has two posts in flight, so it does not
 *     produce that.
 *   - a request without the header behaves exactly as before.
 */

export const IDEMPOTENCY_TTL_MS = 10 * 60_000;
export const MAX_IDEMPOTENCY_KEYS = 10_000;

/** Random tokens only: long enough to be unguessable, short enough to bound memory. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function isValidIdempotencyKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export interface StoredResponse {
  status: number;
  body: unknown;
}

export class IdempotencyCache {
  // A Map iterates in insertion order, which makes the oldest entry the first.
  private readonly entries = new Map<string, { expiresAt: number; response: StoredResponse }>();

  constructor(
    private readonly ttlMs = IDEMPOTENCY_TTL_MS,
    private readonly maxKeys = MAX_IDEMPOTENCY_KEYS,
  ) {}

  get(key: string, now: number): StoredResponse | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    return entry.response;
  }

  set(key: string, response: StoredResponse, now: number): void {
    this.entries.delete(key);
    this.entries.set(key, { expiresAt: now + this.ttlMs, response });
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
