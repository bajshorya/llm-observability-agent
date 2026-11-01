import { describe, expect, it } from "vitest";
import { isFiltered, parseFilters } from "./filters";

describe("parseFilters", () => {
  it("defaults to everything", () => {
    const f = parseFilters({});
    expect(f).toEqual({ service: null, severity: null, verdict: null, status: null, since: "all", q: null });
    expect(isFiltered(f)).toBe(false);
  });

  it("accepts known values", () => {
    const f = parseFilters({ service: "orders-api", severity: "critical", verdict: "real", status: "open", since: "24h", q: " toFixed " });
    expect(f).toEqual({ service: "orders-api", severity: "critical", verdict: "real", status: "open", since: "24h", q: "toFixed" });
    expect(isFiltered(f)).toBe(true);
  });

  it("ignores anything outside the allowlists rather than querying with it", () => {
    const f = parseFilters({ severity: "catastrophic", verdict: "maybe", status: "x'; drop table", since: "1y" });
    expect(f).toMatchObject({ severity: null, verdict: null, status: null, since: "all" });
  });

  it("takes the first of a repeated parameter and bounds free text", () => {
    const f = parseFilters({ severity: ["high", "low"], q: "a".repeat(500) });
    expect(f.severity).toBe("high");
    expect(f.q).toHaveLength(100);
  });
});
