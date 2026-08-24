/**
 * `@obs/shared` — the contract every other package imports.
 *
 * This package exists so that the backend, the generator, and any future
 * dashboard agree on the shape of a log entry, an anomaly, and an LLM response
 * without any of them depending on each other. It is the only package with no
 * dependencies of its own beyond Zod.
 *
 * What lives here, and why it is here rather than in the backend:
 *
 *   - `schemas/log`       the wire format for ingestion. The generator builds
 *                         entries against it; the backend validates against it.
 *                         One definition, so they cannot drift apart.
 *   - `schemas/anomaly`   what Tier 1 produces — statuses, severities, and the
 *                         discriminated union of trigger kinds.
 *   - `schemas/agents`    what the LLM agents must return. Every model response
 *                         is parsed into one of these before use.
 *   - `schemas/commit`    source history as the correlation agent sees it —
 *                         the second data source, and the only one that does
 *                         not come from the running service.
 *   - `signature`         error-message normalisation, used at ingest time by
 *                         the backend and (indirectly) by the evidence sampler.
 *
 * Consumed directly as TypeScript — there is no build step between packages, so
 * an edit here is visible everywhere immediately, and a breaking change fails
 * `pnpm typecheck` across the whole workspace rather than at runtime.
 */

export * from "./schemas/log";
export * from "./schemas/anomaly";
export * from "./schemas/agents";
export * from "./schemas/commit";
export * from "./signature";
