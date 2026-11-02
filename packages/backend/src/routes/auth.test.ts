import { describe, expect, it } from "vitest";
import { bearerToken, isIngestAuthorized } from "./auth";

describe("bearerToken", () => {
  it("extracts the token, case-insensitively on the scheme", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
    expect(bearerToken("bearer abc123")).toBe("abc123");
    expect(bearerToken("Bearer   abc123  ")).toBe("abc123");
  });

  it("rejects anything that is not a single bearer token", () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("")).toBeNull();
    expect(bearerToken("Basic abc123")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Bearer a b")).toBeNull();
    expect(bearerToken("abc123")).toBeNull();
  });
});

describe("isIngestAuthorized", () => {
  it("lets everything through when no key is configured", () => {
    expect(isIngestAuthorized(undefined, undefined)).toBe(true);
    expect(isIngestAuthorized("Bearer anything", undefined)).toBe(true);
  });

  it("requires the exact key once one is configured", () => {
    expect(isIngestAuthorized("Bearer s3cret", "s3cret")).toBe(true);
    expect(isIngestAuthorized(undefined, "s3cret")).toBe(false);
    expect(isIngestAuthorized("Bearer wrong", "s3cret")).toBe(false);
    expect(isIngestAuthorized("Bearer s3cre", "s3cret")).toBe(false);
    expect(isIngestAuthorized("Bearer s3cretX", "s3cret")).toBe(false);
    expect(isIngestAuthorized("s3cret", "s3cret")).toBe(false);
  });
});
