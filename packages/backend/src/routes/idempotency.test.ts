import { describe, expect, it } from "vitest";
import { IdempotencyCache, isValidIdempotencyKey } from "./idempotency";

const response = (accepted: number) => ({ status: 202, body: { accepted, rejected: 0, errors: [] } });

describe("IdempotencyCache", () => {
  it("returns the stored response for a repeated key", () => {
    const cache = new IdempotencyCache();
    cache.set("k".repeat(16), response(5), 0);
    expect(cache.get("k".repeat(16), 1_000)).toEqual(response(5));
    expect(cache.get("x".repeat(16), 1_000)).toBeNull();
  });

  it("forgets a key after its TTL", () => {
    const cache = new IdempotencyCache(100);
    cache.set("k".repeat(16), response(1), 0);
    expect(cache.get("k".repeat(16), 99)).not.toBeNull();
    expect(cache.get("k".repeat(16), 100)).toBeNull();
    expect(cache.size).toBe(0);
  });

  it("stays bounded, evicting the oldest key first", () => {
    const cache = new IdempotencyCache(60_000, 3);
    for (const key of ["a", "b", "c", "d"]) cache.set(key.repeat(16), response(1), 0);
    expect(cache.size).toBe(3);
    expect(cache.get("a".repeat(16), 1)).toBeNull();
    expect(cache.get("d".repeat(16), 1)).not.toBeNull();
  });
});

describe("isValidIdempotencyKey", () => {
  it("accepts UUIDs and similar random tokens", () => {
    expect(isValidIdempotencyKey("5f2b8c1e-8a4d-4f0e-9b6a-1c2d3e4f5a6b")).toBe(true);
    expect(isValidIdempotencyKey("abcdefghijklmnop")).toBe(true);
  });

  it("rejects short, long and non-token keys", () => {
    expect(isValidIdempotencyKey("short")).toBe(false);
    expect(isValidIdempotencyKey("x".repeat(129))).toBe(false);
    expect(isValidIdempotencyKey("has spaces in it ok")).toBe(false);
    expect(isValidIdempotencyKey("../../etc/passwd-xx")).toBe(false);
  });
});
