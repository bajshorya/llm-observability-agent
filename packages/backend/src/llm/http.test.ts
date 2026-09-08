/**
 * Tests for the retry-delay parser.
 *
 * Every body here is one a provider actually returned. The per-minute 429 is
 * copied from a real run, because reading only the `Retry-After` header — which
 * Google does not send — is what made a forty-second wait look like an
 * exhausted daily quota.
 */

import { describe, expect, it } from "vitest";
import { serverRequestedDelayMs } from "./http";

/** Minimal stand-in; only `headers.get` is used. */
const res = (retryAfter: string | null): Response =>
  ({ headers: { get: () => retryAfter } }) as unknown as Response;

const PER_MINUTE_429 =
  '{"error":{"code":429,"message":"You exceeded your current quota. ' +
  "\\n* Quota exceeded for metric: generativelanguage.googleapis.com/" +
  'generate_content_free_tier_requests, limit: 5, model: gemini-3.5-flash' +
  '\\nPlease retry in 42.232374356s.","status":"RESOURCE_EXHAUSTED"}}';

const RETRY_INFO =
  '{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo",' +
  '"retryDelay":"38s"}]}}';

describe("serverRequestedDelayMs", () => {
  it("reads the delay from a Retry-After header", () => {
    expect(serverRequestedDelayMs(res("12"), undefined)).toBe(12_000);
  });

  it("reads Google's RetryInfo detail when there is no header", () => {
    expect(serverRequestedDelayMs(res(null), RETRY_INFO)).toBe(38_000);
  });

  it("falls back to the delay in the message text", () => {
    // The shape that actually arrives on a free-tier per-minute 429.
    expect(serverRequestedDelayMs(res(null), PER_MINUTE_429)).toBeCloseTo(42_232, -2);
  });

  it("prefers the header over the body when both are present", () => {
    expect(serverRequestedDelayMs(res("7"), PER_MINUTE_429)).toBe(7_000);
  });

  it("returns null when nothing asks for a delay, so backoff stays exponential", () => {
    expect(serverRequestedDelayMs(res(null), '{"error":{"code":500}}')).toBeNull();
    expect(serverRequestedDelayMs(res(null), undefined)).toBeNull();
  });

  it("ignores a non-numeric Retry-After rather than producing NaN", () => {
    // HTTP allows an HTTP-date here. Treat it as absent instead of waiting NaN.
    expect(serverRequestedDelayMs(res("Wed, 21 Oct 2026 07:28:00 GMT"), undefined)).toBeNull();
  });
});
