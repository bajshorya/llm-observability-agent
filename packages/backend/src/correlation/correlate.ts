/**
 * Phase 3 orchestration — loading evidence, calling the model, persisting the
 * correlation.
 *
 * WHAT THIS FILE DOES
 * For each real, uncorrelated incident: collects the candidate commits, renders
 * the packet, sends it through `generateStructured`, checks the answer against
 * the evidence, and writes a `correlations` row. The impure counterpart to the
 * pure `context.ts` and `grounding.ts`.
 *
 * WHY IT IS A THIRD COMMAND AND NOT PART OF `pnpm classify`
 * Same argument that separated classification from detection, one tier along.
 * Each stage that spends quota is an explicit act. It also means a correlation
 * run can be repeated against a different provider without re-classifying, and
 * that a broken correlator cannot take classification down with it.
 *
 * WHAT "UNCORRELATED" MEANS
 * A real incident with no `correlations` row: `is_real_incident = 1` and no
 * matching row in `correlations`. Two things follow from that definition.
 *
 * Benign windows are never correlated. Tier 2 already dismissed them, and
 * looking for the commit that caused a rolling restart is exactly the wasted
 * call the two-tier design exists to avoid. The funnel narrows again here.
 *
 * The absence of a row is the flag, rather than a status value. `status` moves
 * `open → correlated`, but keying the query off `status` would mean an anomaly
 * a later phase moved on was silently re-correlated. This mirrors Tier 2's
 * `severity IS NULL` rule for the same reason.
 *
 * A NULL SHA IS STILL A ROW
 * "No commit explains this" is a finding, and it costs a model call to reach.
 * Writing it down means the next run does not pay for it again, and it makes
 * "the correlator declined" visible in the data rather than indistinguishable
 * from "the correlator never ran". `suspectedCommitSha` is nullable precisely
 * so this row can exist.
 *
 * THE STATUS TRANSITION THIS FILE OWNS
 * `open → correlated`, whether or not a commit was named. The status records
 * that the stage ran, not that it succeeded in blaming something.
 *
 * WHAT HAPPENS WHEN THE ANSWER IS NOT GROUNDED
 * An invented sha fails the anomaly rather than being coerced to null, and no
 * row is written — see `grounding.ts` for why. The row keeps no correlation and
 * is retried next run, which is the same failure posture Tier 2 uses for a
 * quota error.
 *
 * NO COMMITS IS NOT A FAILURE
 * If the lookback returns nothing, the model is still called, and the packet
 * says so explicitly. That is deliberate: a run that skipped the call whenever
 * the list was empty would never produce the "searched, found nothing" answer,
 * and `null` would come to mean two different things in the same column.
 */

import { and, asc, desc, eq, notInArray, sql } from "drizzle-orm";
import {
  correlationSchema,
  type CandidateCommit,
  type Correlation,
  type LlmCallStats,
  type Severity,
} from "@obs/shared";
import { db } from "../db/client";
import { anomalies, correlations } from "../db/schema";
import { recordLlmCall } from "../llm/calls";
import { createProvider } from "../llm";
import { generateStructured } from "../llm/structured";
import type { LlmProvider } from "../llm/types";
import { renderCorrelationContext, type CorrelationInput } from "./context";
import { collectCommits, defaultLookback } from "./git";
import { groundCorrelation, type GroundedCorrelation } from "./grounding";
import { CORRELATOR_SYSTEM_PROMPT } from "./prompt";

export type CorrelationStatus = "correlated" | "failed";

export interface CorrelationOutcome {
  anomalyId: string;
  service: string;
  status: CorrelationStatus;
  /** How many commits the model chose from. Zero is meaningful, not an error. */
  candidateCount?: number;
  correlation?: Correlation;
  grounded?: GroundedCorrelation;
  stats?: LlmCallStats;
  error?: string;
}

export interface CorrelationRunResult {
  provider: string;
  model: string;
  outcomes: CorrelationOutcome[];
}

export interface CorrelateOptions {
  provider?: LlmProvider | undefined;
  /** Cap per run, so a backlog cannot empty a free-tier quota in one go. */
  limit?: number | undefined;
  /** Correlate one specific anomaly, even if already correlated. */
  anomalyId?: string | undefined;
  lookbackHours?: number | undefined;
  maxCommits?: number | undefined;
  repoPath?: string | undefined;
}

interface PendingIncident {
  id: string;
  service: string;
  windowStart: Date;
  windowEnd: Date;
  triggers: CorrelationInput["triggers"];
  severity: Severity | null;
  summary: string | null;
  affectedArea: string | null;
}

const INCIDENT_COLUMNS = {
  id: anomalies.id,
  service: anomalies.service,
  windowStart: anomalies.windowStart,
  windowEnd: anomalies.windowEnd,
  triggers: anomalies.triggers,
  severity: anomalies.severity,
  summary: anomalies.summary,
  affectedArea: anomalies.affectedArea,
};

/**
 * Real incidents with no correlation row yet, oldest first.
 *
 * The `notInArray` subquery is what makes "uncorrelated" mean the absence of a
 * row rather than a status value — see the header on why that distinction
 * matters once a later phase starts moving `status` again.
 */
async function loadPending(options: CorrelateOptions): Promise<PendingIncident[]> {
  if (options.anomalyId) {
    return db.select(INCIDENT_COLUMNS).from(anomalies).where(eq(anomalies.id, options.anomalyId));
  }

  const alreadyCorrelated = db.select({ id: correlations.anomalyId }).from(correlations);

  return db
    .select(INCIDENT_COLUMNS)
    .from(anomalies)
    .where(
      and(
        eq(anomalies.isRealIncident, true),
        notInArray(anomalies.id, alreadyCorrelated),
      ),
    )
    .orderBy(asc(anomalies.detectedAt))
    .limit(options.limit ?? 10);
}

/**
 * Assemble the packet input.
 *
 * The classifier's verdict is required, not optional. An anomaly with a null
 * severity has not been through Tier 2, and correlating it would mean asking
 * which commit caused something nobody has established is an incident.
 */
export async function buildCorrelationInput(
  incident: PendingIncident,
  options: CorrelateOptions = {},
): Promise<CorrelationInput> {
  if (incident.severity === null || incident.summary === null) {
    throw new Error(
      `anomaly ${incident.id} has not been classified — run \`pnpm classify\` first`,
    );
  }

  const commits = await collectCommits({
    until: incident.windowEnd,
    ...(options.lookbackHours !== undefined ? { lookbackHours: options.lookbackHours } : {}),
    ...(options.maxCommits !== undefined ? { maxCommits: options.maxCommits } : {}),
    ...(options.repoPath !== undefined ? { repoPath: options.repoPath } : {}),
  });

  return {
    service: incident.service,
    windowStart: incident.windowStart,
    windowEnd: incident.windowEnd,
    triggers: incident.triggers,
    severity: incident.severity,
    summary: incident.summary,
    // Tier 2 offers "unknown" as an explicit escape hatch; a null column here
    // means an older row written before that field existed.
    affectedArea: incident.affectedArea ?? "unknown",
    commits,
  };
}

/**
 * Persist the correlation and mark the stage as having run.
 *
 * Both writes happen even when the sha is null. The row records a considered
 * "no commit explains this"; the status records that the correlator looked.
 */
async function persistCorrelation(
  anomalyId: string,
  correlation: Correlation,
  grounded: GroundedCorrelation,
): Promise<void> {
  await db.insert(correlations).values({
    anomalyId,
    suspectedCommitSha: grounded.sha,
    confidence: correlation.confidence,
    reasoning: correlation.reasoning,
    implicatedFiles: grounded.implicatedFiles,
  });

  await db.update(anomalies).set({ status: "correlated" }).where(eq(anomalies.id, anomalyId));
}

export async function correlateAnomalies(
  options: CorrelateOptions = {},
): Promise<CorrelationRunResult> {
  const provider = options.provider ?? createProvider();
  const pending = await loadPending(options);
  const outcomes: CorrelationOutcome[] = [];

  for (const incident of pending) {
    try {
      const input = await buildCorrelationInput(incident, options);
      const candidates: readonly CandidateCommit[] = input.commits.commits;

      const { value, stats } = await generateStructured({
        provider,
        schema: correlationSchema,
        system: CORRELATOR_SYSTEM_PROMPT,
        user: renderCorrelationContext(input),
        agent: "correlator",
        anomalyId: incident.id,
        onCall: recordLlmCall,
      });

      // Well-formed is not the same as true to the evidence. A sha naming no
      // candidate is a hallucination, and persisting it would hand Phase 4 an
      // invented fact to reason from.
      const result = groundCorrelation(value, candidates);

      if (!result.ok) {
        outcomes.push({
          anomalyId: incident.id,
          service: incident.service,
          status: "failed",
          candidateCount: candidates.length,
          correlation: value,
          stats,
          error: result.reason,
        });
        continue;
      }

      await persistCorrelation(incident.id, value, result.grounded);

      outcomes.push({
        anomalyId: incident.id,
        service: incident.service,
        status: "correlated",
        candidateCount: candidates.length,
        correlation: value,
        grounded: result.grounded,
        stats,
      });
    } catch (error) {
      /**
       * One incident failing does not stop the run — same posture as Tier 2,
       * and for the same most-likely cause. A missing target repository fails
       * every incident in the run with the same message, which is the correct
       * and legible outcome rather than something to special-case.
       */
      outcomes.push({
        anomalyId: incident.id,
        service: incident.service,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { provider: provider.name, model: provider.model, outcomes };
}

export interface CorrelationFunnel {
  realIncidents: number;
  correlated: number;
  /** Correlations that named a commit. */
  attributed: number;
  /** Correlations that considered the candidates and declined. */
  declined: number;
}

/**
 * The funnel, one tier further down than Tier 2's.
 *
 * `declined` is reported separately from `attributed` for the same reason the
 * eval scorecard splits benign from incident: a correlator that names a commit
 * every time and one that never does would otherwise look identical here, and
 * they are opposite failures.
 */
export async function correlationFunnel(): Promise<CorrelationFunnel> {
  const [incidents] = await db
    .select({
      realIncidents: sql<number>`sum(case when ${anomalies.isRealIncident} = 1 then 1 else 0 end)`,
    })
    .from(anomalies);

  const [rows] = await db
    .select({
      correlated: sql<number>`count(*)`,
      attributed: sql<number>`sum(case when ${correlations.suspectedCommitSha} is not null then 1 else 0 end)`,
      declined: sql<number>`sum(case when ${correlations.suspectedCommitSha} is null then 1 else 0 end)`,
    })
    .from(correlations);

  return {
    realIncidents: incidents?.realIncidents ?? 0,
    correlated: rows?.correlated ?? 0,
    attributed: rows?.attributed ?? 0,
    declined: rows?.declined ?? 0,
  };
}

export interface RenderedCorrelationContext {
  anomalyId: string;
  service: string;
  candidateCount: number;
  context: string;
  /**
   * The commits the packet was built from. Returned so that capturing a golden
   * case can resolve an abbreviated expected sha against the very candidates
   * that case will contain, rather than against whatever the repository holds
   * at some later moment.
   */
  commits: readonly CandidateCommit[];
}

/**
 * Build the packet for one incident, defaulting to the most recent real one.
 *
 * The default exists for the same reason Tier 2's does: it makes inspecting the
 * prompt a single command with no id to copy between steps.
 */
export async function renderContextForIncident(
  anomalyId?: string,
  options: CorrelateOptions = {},
): Promise<RenderedCorrelationContext | null> {
  const [incident] = anomalyId
    ? await db.select(INCIDENT_COLUMNS).from(anomalies).where(eq(anomalies.id, anomalyId))
    : await db
        .select(INCIDENT_COLUMNS)
        .from(anomalies)
        .where(eq(anomalies.isRealIncident, true))
        .orderBy(desc(anomalies.detectedAt))
        .limit(1);

  if (!incident) return null;

  const input = await buildCorrelationInput(incident, options);

  return {
    anomalyId: incident.id,
    service: incident.service,
    candidateCount: input.commits.commits.length,
    context: renderCorrelationContext(input),
    commits: input.commits.commits,
  };
}

/** Render the full prompt for an incident without calling anything. */
export async function previewCorrelationPrompt(
  anomalyId?: string,
  options: CorrelateOptions = {},
): Promise<string | null> {
  const rendered = await renderContextForIncident(anomalyId, options);
  if (!rendered) return null;

  return `${CORRELATOR_SYSTEM_PROMPT}\n\n---\n\n${rendered.context}`;
}

export { defaultLookback };
