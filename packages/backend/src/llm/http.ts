/**
 * The shared HTTP path: POST JSON, retry what is worth retrying, fail loudly on
 * what is not.
 *
 * WHAT THIS FILE DOES
 * Exports `postJson`, used by every network-backed provider. Kept out of the
 * provider files so that adding a provider is a question of request and
 * response SHAPE only, and so retry policy is decided once rather than three
 * times slightly differently.
 *
 * THE RETRY POLICY, AND THE REASONING BEHIND THE SPLIT
 *
 *   RETRIED    408, 409, 425, 429, 500, 502, 503, 504, and any network or
 *              timeout failure. A 429 in particular is the normal steady state
 *              of a free tier — it means "wait", not "this anomaly cannot be
 *              classified".
 *
 *   NOT RETRIED  400, 401, 403, 404. A malformed request, a bad key, or a
 *              retired model identifier will fail identically forever.
 *              Retrying only delays the error message that tells you WHICH of
 *              those three it is, which is the only useful information in the
 *              response.
 *
 * BACKOFF
 * 500 ms doubling, unless the server asked for a specific delay — honoured up
 * to 30 seconds, because the server knows its own quota window and a constant
 * does not.
 *
 * ERROR DETAIL IS PRESERVED
 * The response body is read and included in the thrown error (truncated to 500
 * chars). That body usually carries the actual reason — "quota exceeded for
 * metric X, limit 20", "unknown model" — and discarding it in favour of a bare
 * status code turns a diagnosable failure into a mystery.
 */

import { llmConfig } from "./config";
import { LlmProviderError } from "./types";

/**
 * Retried: rate limits, request timeouts, and server-side faults. A 429 in
 * particular is the normal steady state of a free tier — it means "wait",
 * not "this anomaly cannot be classified".
 *
 * Not retried: 400/401/403/404. A malformed request, a bad key or a retired
 * model identifier will fail identically forever, and retrying only delays
 * the error message that tells you which of those it is.
 */
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const BASE_BACKOFF_MS = 500;

/**
 * Above this, a delay is a rate-limit window rather than ordinary backoff, and
 * is worth waiting for at most once. See the retry loop.
 */
const SHORT_WAIT_MS = 5_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Ceiling on an honoured server delay. A free tier's per-minute window is 60s. */
const MAX_HONOURED_DELAY_MS = 65_000;

/**
 * A retry delay the server asked for, in milliseconds, or null.
 *
 * Checked in two places because providers put it in two places. A
 * `Retry-After` header is the HTTP-standard answer; Google's APIs instead
 * return it in the JSON body, either as a `RetryInfo` detail or in the message
 * text ("Please retry in 42.23s").
 *
 * Reading only the header was a real bug, and an expensive one to diagnose. A
 * free-tier key has TWO quotas — five requests per minute and twenty per day —
 * and the per-minute one is hit constantly, because an eval fires six cases
 * back to back. With no header to read, backoff fell to 500ms then 1s and gave
 * up inside the same rate-limited minute, so a run that only needed to wait
 * forty seconds failed instead. Worse, it failed with a message naming the
 * DAILY quota, which is how it got misread as "quota exhausted, come back
 * tomorrow" for far longer than it should have.
 */
export function serverRequestedDelayMs(response?: Response, body?: string): number | null {
  const header = response?.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }

  if (!body) return null;

  // Google's RetryInfo detail: "retryDelay": "42s"
  const retryInfo = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  if (retryInfo?.[1]) return Number(retryInfo[1]) * 1000;

  // Failing that, the human-readable form in the message.
  const inMessage = /retry in (\d+(?:\.\d+)?)\s*s/i.exec(body);
  if (inMessage?.[1]) return Number(inMessage[1]) * 1000;

  return null;
}

/** Honour what the server asked for; it knows better than we do. */
function backoffMs(attempt: number, response?: Response, body?: string): number {
  const requested = serverRequestedDelayMs(response, body);
  if (requested !== null && requested >= 0) {
    return Math.min(requested, MAX_HONOURED_DELAY_MS);
  }
  return BASE_BACKOFF_MS * 2 ** attempt;
}

export interface PostJsonOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** Provider name, for error attribution. */
  provider: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

export async function postJson(options: PostJsonOptions): Promise<unknown> {
  const {
    url,
    headers,
    body,
    provider,
    timeoutMs = llmConfig.timeoutMs,
    maxAttempts = llmConfig.maxHttpAttempts,
  } = options;

  let lastError: LlmProviderError | undefined;
  /** Whether a long, server-requested delay has already been waited out. */
  let waitedLong = false;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response: Response;

    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Network failure or timeout — no response to inspect, always retryable.
      lastError = new LlmProviderError(
        `${provider}: request failed (${error instanceof Error ? error.message : String(error)})`,
        provider,
      );
      if (attempt < maxAttempts - 1) await sleep(backoffMs(attempt));
      continue;
    }

    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw new LlmProviderError(`${provider}: response was not valid JSON`, provider);
      }
    }

    // Body often carries the actual reason (quota exhausted, unknown model).
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    const error = new LlmProviderError(
      `${provider}: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
      provider,
      response.status,
    );

    if (!RETRYABLE_STATUSES.has(response.status)) throw error;

    lastError = error;
    if (attempt >= maxAttempts - 1) break;

    const wait = backoffMs(attempt, response, detail);

    /**
     * Honour a long server-requested delay ONCE, then stop.
     *
     * The two free-tier quotas need opposite treatment and are told apart only
     * by a number buried in the message. A per-minute limit clears after one
     * wait; a daily one does not clear at all, and both ask you to retry in
     * about forty seconds.
     *
     * Waiting repeatedly for the daily one is strictly worse than failing:
     * measured, a six-case eval against an exhausted key took ten minutes to
     * report what it could have reported in five seconds. Waiting once
     * rescues the per-minute case — which is the common one, since an eval
     * fires its cases back to back — and a second identical refusal is taken
     * as evidence that waiting is not going to help.
     */
    if (waitedLong && wait > SHORT_WAIT_MS) break;

    if (wait > SHORT_WAIT_MS) {
      waitedLong = true;
      /**
       * Announced, because otherwise it is invisible.
       *
       * A rate-limit wait is the difference between a run taking forty seconds
       * and taking ninety, and with no output the only evidence is arithmetic
       * on the mean latency afterwards. That is exactly how this path was
       * confirmed the first time, and nobody should have to do that twice.
       *
       * On stderr so it never pollutes piped stdout.
       */
      console.warn(
        `  ${provider}: rate limited, waiting ${Math.round(wait / 1000)}s as asked ` +
          `(this happens once per request; a repeat is treated as exhausted)`,
      );
    }

    await sleep(wait);
  }

  throw lastError ?? new LlmProviderError(`${provider}: request failed`, provider);
}
