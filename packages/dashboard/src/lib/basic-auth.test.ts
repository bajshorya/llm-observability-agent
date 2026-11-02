import { describe, expect, it } from "vitest";
import { basicAuthPassword, isAuthorized } from "./basic-auth";

const basic = (credentials: string) => `Basic ${Buffer.from(credentials).toString("base64")}`;

describe("basic auth", () => {
  it("reads the password, whatever the username", () => {
    expect(basicAuthPassword(basic("admin:s3cret"))).toBe("s3cret");
    expect(basicAuthPassword(basic(":s3cret"))).toBe("s3cret");
    expect(basicAuthPassword(basic("me:pass:with:colons"))).toBe("pass:with:colons");
  });

  it("rejects missing, malformed and non-basic headers", () => {
    expect(basicAuthPassword(null)).toBeNull();
    expect(basicAuthPassword("Bearer abc")).toBeNull();
    expect(basicAuthPassword("Basic !!!")).toBeNull();
    expect(basicAuthPassword(basic("no-colon"))).toBeNull();
  });

  it("accepts exactly the configured password", () => {
    expect(isAuthorized(basic("u:s3cret"), "s3cret")).toBe(true);
    expect(isAuthorized(basic("u:s3cre"), "s3cret")).toBe(false);
    expect(isAuthorized(basic("u:s3cretX"), "s3cret")).toBe(false);
    expect(isAuthorized(basic("u:"), "s3cret")).toBe(false);
    expect(isAuthorized(null, "s3cret")).toBe(false);
  });
});
