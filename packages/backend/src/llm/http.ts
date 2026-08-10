import { llmConfig } from "./config";
import { LlmProviderError } from "./types";

/**
 * The one HTTP path every network-backed provider shares: POST JSON, retry the
 * failures that are worth retrying, give up loudly on the ones that are not.
 *
 * Kept out of the provider files so that adding a provider is a question of
 * request and response shape only, and so retry policy is decided once.
 */

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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Honour `Retry-After` when the server sends it; it knows better than we do. */
function backoffMs(attempt: number, response?: Response): number {
  const header = response?.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 30_000);
    }
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
    if (attempt < maxAttempts - 1) await sleep(backoffMs(attempt, response));
  }

  throw lastError ?? new LlmProviderError(`${provider}: request failed`, provider);
}
