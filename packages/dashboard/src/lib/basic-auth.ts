/**
 * HTTP Basic auth for the dashboard — pure.
 *
 * The dashboard shows log lines, commit diffs, root-cause write-ups and
 * suggested fixes. On a laptop that is fine open; on any host other people can
 * reach it is a read of the system's internals, so `DASHBOARD_PASSWORD` puts
 * a password in front of every page (src/proxy.ts). Unset, nothing changes.
 *
 * Basic auth, not a login page: the dashboard has no users, no sessions and
 * no writes, and a browser's built-in prompt is the smallest correct thing.
 * It is only private over HTTPS — the password is base64, not encrypted — so
 * a public deployment belongs behind a TLS-terminating proxy, which is where
 * real SSO would go too. The username is not checked; there is one password.
 */

import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value).digest();

/** The password from `Authorization: Basic base64(user:password)`, or null. */
export function basicAuthPassword(header: string | null): string | null {
  if (!header) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon === -1 ? null : decoded.slice(colon + 1);
}

/** True when the header carries exactly `password`. Constant-time in the guess. */
export function isAuthorized(header: string | null, password: string): boolean {
  const given = basicAuthPassword(header);
  if (given === null) return false;
  return timingSafeEqual(digest(given), digest(password));
}
