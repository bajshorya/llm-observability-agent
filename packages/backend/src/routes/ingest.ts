import type { FastifyInstance } from "fastify";
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

/**
 * Ingestion is deliberately dumb: validate, then persist. No detection, no
 * enrichment, no branching on content. It sits in the hot path of every
 * monitored service, so the only things it is allowed to be are correct
 * and fast.
 */

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
  app.post("/ingest", async (request, reply) => {
    const envelope = envelopeSchema.safeParse(request.body);

    if (!envelope.success) {
      return reply.code(400).send({
        error: "invalid_batch",
        message: describeIssue(envelope.error),
      });
    }

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
