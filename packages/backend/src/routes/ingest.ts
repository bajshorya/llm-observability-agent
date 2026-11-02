/**
 * `POST /ingest` — the one write path into the system.
 *
 * WHAT THIS FILE DOES
 * Accepts a batch of structured log entries, validates each one, computes an
 * error signature where applicable, and inserts. That is the whole endpoint.
 *
 * WHY IT IS DELIBERATELY DUMB
 * This sits in the hot path of every monitored service. No detection, no
 * enrichment, no branching on content — the only things it is allowed to be are
 * correct and fast. Everything analytical happens later, in a command, reading
 * from the table this fills.
 *
 * PARTIAL SUCCESS, AND WHY
 * The envelope is validated first (an array of 1..1000 unknowns); a malformed
 * envelope is a 400. Then each entry is validated INDIVIDUALLY. One bad entry
 * in a batch of 500 must not cost the other 499 — a monitored service should
 * not lose a minute of telemetry because one log line had a malformed
 * timestamp. Rejected entries are reported by index with a reason, capped at 20
 * so the response stays bounded.
 *
 *   202 Accepted   everything went in
 *   207 Multi-Status  some entries were rejected; the rest were stored
 *
 * THE ONE DELIBERATE EXCEPTION TO "JUST PERSIST"
 * `normalizeErrorSignature` runs here, at write time, for warn/error/fatal
 * entries. Strictly that is a hair more than validate-and-store, and it is
 * justified: it is a pure O(1) string transform, and precomputing it turns the
 * new-error-signature detector into an indexed lookup instead of a regex pass
 * over millions of rows at query time. Doing it at read time would move real
 * cost into the detection path to save nothing here.
 *
 * TIMESTAMPS FROM THE FUTURE ARE REJECTED
 * More than MAX_FUTURE_SKEW_MS ahead of this server's clock is a per-entry
 * rejection. This is not tidiness. Detection anchors its window to the newest
 * rollup ANYWHERE, so one line stamped next year — a client sending epoch
 * microseconds is enough — would move every service's window into an empty
 * future and blind all detection until the wall clock caught up. The same line
 * would also make its service impossible to see go silent, because its "last
 * seen" would be ahead of now. Five minutes absorbs ordinary clock skew.
 *
 * AUTHENTICATION
 * When `INGEST_API_KEY` is set, a request without `Authorization: Bearer <key>`
 * is a 401 from an `onRequest` hook, before the body is even read. Unset, ingest is open. routes/auth.ts.
 *
 * Inserts are chunked at 250 rows to stay well under SQLite's bound-parameter
 * limit per statement.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  hasErrorSignature,
  logEntrySchema,
  MAX_BATCH_SIZE,
  normalizeErrorSignature,
  type IngestResult,
} from "@obs/shared";
import { db } from "../db/client";
import { logs, type NewLogRow } from "../db/schema";
import { env } from "../env";
import { isIngestAuthorized } from "./auth";

/** How far ahead of this server's clock a timestamp may be. See the header. */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/** SQLite caps bound parameters per statement; chunk to stay well under it. */
const INSERT_CHUNK_SIZE = 250;
/** Cap on how many rejection reasons we echo back — enough to debug, not enough to abuse. */
const MAX_REPORTED_ERRORS = 20;

/** Outer envelope only. Entries are validated one at a time, below. */
const envelopeSchema = z.object({
  entries: z.array(z.unknown()).min(1).max(MAX_BATCH_SIZE),
});

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid entry";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

export function registerIngestRoute(app: FastifyInstance): void {
  /**
   * `onRequest`, not the handler: it runs before Fastify reads and parses the
   * body, so an unauthenticated client cannot make the server parse up to
   * 16 MB of JSON just to be told no.
   */
  const requireKey = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isIngestAuthorized(request.headers.authorization, env.INGEST_API_KEY)) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "POST /ingest requires Authorization: Bearer <INGEST_API_KEY>.",
      });
    }
  };

  app.post("/ingest", { onRequest: requireKey }, async (request, reply) => {
    const envelope = envelopeSchema.safeParse(request.body);

    if (!envelope.success) {
      return reply.code(400).send({
        error: "invalid_batch",
        message: describeIssue(envelope.error),
      });
    }

    const latestAllowed = Date.now() + MAX_FUTURE_SKEW_MS;
    const rows: NewLogRow[] = [];
    const errors: IngestResult["errors"] = [];

    /**
     * Partial success on purpose. One malformed entry in a batch of 500
     * should not cost us the other 499 — we take what is valid and report
     * precisely what was not.
     */
    envelope.data.entries.forEach((raw, index) => {
      const parsed = logEntrySchema.safeParse(raw);

      if (!parsed.success) {
        if (errors.length < MAX_REPORTED_ERRORS) {
          errors.push({ index, reason: describeIssue(parsed.error) });
        }
        return;
      }

      const entry = parsed.data;
      if (entry.timestamp.getTime() > latestAllowed) {
        if (errors.length < MAX_REPORTED_ERRORS) {
          errors.push({
            index,
            reason: "timestamp: more than 5 minutes in the future — check the sender's clock and units",
          });
        }
        return;
      }

      rows.push({
        timestamp: entry.timestamp,
        service: entry.service,
        level: entry.level,
        message: entry.message,
        errorSignature: hasErrorSignature(entry.level)
          ? normalizeErrorSignature(entry.message)
          : null,
        metadata: entry.metadata,
      });
    });

    if (rows.length > 0) {
      for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
        await db.insert(logs).values(rows.slice(i, i + INSERT_CHUNK_SIZE));
      }
    }

    const rejected = envelope.data.entries.length - rows.length;
    const result: IngestResult = {
      accepted: rows.length,
      rejected,
      errors,
    };

    // 207 signals "some of this batch did not make it" without failing the whole call.
    return reply.code(rejected > 0 ? 207 : 202).send(result);
  });
}