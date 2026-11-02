/**
 * Ingest authentication — pure.
 *
 * WHAT THIS FILE DOES
 * Decides whether a request may write to `POST /ingest`, given the request's
 * `Authorization` header and the configured `INGEST_API_KEY`.
 *
 * WHY IT IS OPTIONAL
 * With no key configured, ingest stays open, exactly as before. That is what
 * keeps `bash scripts/demo.sh`, the generator and the tests working on a fresh
 * clone with nothing configured. The server warns at startup when it is
 * listening on every interface with no key, because then anything that can
 * reach the port can write logs — and logs are what the models read, so an
 * open ingest is also an open door into the prompt.
 *
 * WHY ONE SHARED KEY, NOT PER-SERVICE KEYS
 * One key per deployment is the smallest thing that closes the open endpoint.
 * It does not stop one authorised service from writing logs under another
 * service's name; per-service keys bound to a `service` value would, at the
 * cost of a key table and a way to issue keys. Not built until it is needed.
 *
 * COMPARISON
 * Both sides are hashed before `timingSafeEqual`, so the comparison takes the
 * same time whatever the length or content of the guess.
 */

import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** The token from `Authorization: Bearer <token>`, or null. Scheme is case-insensitive. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

/** True when no key is configured, or when the header carries exactly that key. */
export function isIngestAuthorized(header: string | undefined, apiKey: string | undefined): boolean {
  if (apiKey === undefined) return true;
  const token = bearerToken(header);
  if (token === null) return false;
  return timingSafeEqual(digest(token), digest(apiKey));
}
