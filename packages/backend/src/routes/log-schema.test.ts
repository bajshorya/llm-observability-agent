/**
 * The ingest boundary's per-entry rules. The schema lives in @obs/shared,
 * which has no test runner of its own; it is tested here, beside the route
 * that enforces it.
 */

import { describe, expect, it } from "vitest";
import { logEntrySchema, MAX_METADATA_BYTES } from "@obs/shared";

const base = {
  timestamp: "2026-11-02T10:00:00.000Z",
  service: "orders-api",
  level: "error",
  message: "TypeError: Cannot read properties of null",
};

const ok = (entry: Record<string, unknown>) => logEntrySchema.safeParse(entry).success;
const reason = (entry: Record<string, unknown>) => {
  const result = logEntrySchema.safeParse(entry);
  return result.success ? null : result.error.issues[0]?.message;
};

describe("logEntrySchema", () => {
  it("accepts an ordinary entry, ISO or epoch milliseconds", () => {
    expect(ok(base)).toBe(true);
    expect(ok({ ...base, timestamp: Date.parse(base.timestamp) })).toBe(true);
  });

  it("rejects epoch seconds with a message that names the mistake", () => {
    expect(reason({ ...base, timestamp: 1_793_619_673 })).toContain("epoch seconds");
  });

  it("rejects timestamps that are not dates at all", () => {
    expect(ok({ ...base, timestamp: "yesterday-ish" })).toBe(false);
    expect(ok({ ...base, timestamp: Number.NaN })).toBe(false);
  });

  it("keeps service names to identifiers", () => {
    for (const name of ["orders-api", "payments_v2", "svc.eu-west-1", "A1"]) {
      expect(ok({ ...base, service: name })).toBe(true);
    }
    for (const name of [
      "",
      "-leading-dash",
      "has space",
      "new\nline",
      "../../etc",
      "a/b",
      "<script>",
      "x".repeat(65),
    ]) {
      expect(ok({ ...base, service: name })).toBe(false);
    }
  });

  it("bounds metadata by its serialised size, not just its known fields", () => {
    expect(ok({ ...base, metadata: { note: "x".repeat(1000) } })).toBe(true);
    expect(ok({ ...base, metadata: { blob: "x".repeat(MAX_METADATA_BYTES) } })).toBe(false);
  });

  it("still bounds message length", () => {
    expect(ok({ ...base, message: "x".repeat(4096) })).toBe(true);
    expect(ok({ ...base, message: "x".repeat(4097) })).toBe(false);
    expect(ok({ ...base, message: "" })).toBe(false);
  });
});
