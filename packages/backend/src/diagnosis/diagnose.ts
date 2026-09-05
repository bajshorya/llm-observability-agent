/**
 * Phase 4 orchestration — loading the incident and its commit, calling the
 * model, persisting the hypothesis.
 *
 * WHAT THIS FILE DOES
 * For each attributed incident with no hypothesis: fetches the blamed commit
 * WITH its diff, renders the packet, sends it through `generateStructured`, and
 * writes a `hypotheses` row. The impure counterpart to the pure `context.ts`.
 *
 * WHAT "PENDING" MEANS, AND THE ONE STAGE THAT NARROWS TWICE
 * A real incident, with a correlation that named a commit, and no hypothesis
 * row. The funnel by this point has narrowed four times:
 *
 *   every window            → what Tier 1 flagged
 *   what Tier 1 flagged     → what Tier 2 called real
 *   what Tier 2 called real → what Phase 3 correlated
 *   what Phase 3 correlated → what it ATTRIBUTED to a commit
 *
 * That last narrowing is this stage's own, and it is a real scoping decision
 * rather than an implementation gap. A correlation that declined has no commit,
 * therefore no diff, therefore nothing to explain a fix against — and "diagnose
 * this from logs alone" is a weaker task that Tier 2's summary already half
 * performs. Incidents with no attributable commit get no hypothesis, and that
 * limitation is stated rather than papered over.
 *
 * WHY THE COMMIT IS RE-FETCHED RATHER THAN STORED
 * `correlations` stores a sha, not a diff. Re-reading the patch from git at
 * diagnosis time means the packet always reflects what the repository actually
 * contains, and a sha that has since been rewritten or garbage-collected fails
 * loudly here instead of producing a confident explanation of a commit that no
 * longer exists.
 *
 * WHY IT FETCHES BY SHA AND NOT BY LOOKBACK
 * `collectCommits` bounds by time, and the commit Phase 3 blamed is guaranteed
 * to be inside that window — but only for the lookback Phase 3 used. Asking git
 * for one sha directly removes the coupling entirely.
 *
 * THE HUMAN GATE
 * `applied` defaults to false and is never written by this file. There is no
 * code path in this repository that applies a suggested fix. That is deliberate
 * and is the whole reason the column exists.
 */

import { and, asc, desc, eq, notInArray, sql } from "drizzle-orm";
import {
  hypothesisSchema,
  type CandidateCommit,
  type Hypothesis,
  type LlmCallStats,
  type Severity,
} from "@obs/shared";
import { db } from "../db/client";
import { anomalies, correlations, hypotheses } from "../db/schema";
import { recordLlmCall } from "../llm/calls";
import { createProvider } from "../llm";
import { generateStructured } from "../llm/structured";
import type { LlmProvider } from "../llm/types";
import { commitBySha } from "../correlation/git";
import { renderDiagnosisContext, type DiagnosisInput } from "./context";
import { ROOT_CAUSE_SYSTEM_PROMPT } from "./prompt";

export type DiagnosisStatus = "diagnosed" | "failed";

export interface DiagnosisOutcome {
  anomalyId: string;
  service: string;
  status: DiagnosisStatus;
  sha?: string;
  hypothesis?: Hypothesis;
  stats?: LlmCallStats;
  error?: string;
}

export interface DiagnosisRunResult {
  provider: string;
  model: string;
  outcomes: DiagnosisOutcome[];
}

export interface DiagnoseOptions {
  provider?: LlmProvider | undefined;
  /** Cap per run, so a backlog cannot empty a free-tier quota in one go. */
  limit?: number | undefined;
  anomalyId?: string | undefined;
  repoPath?: string | undefined;
}

interface PendingDiagnosis {
  id: string;
  service: string;
  windowStart: Date;
  windowEnd: Date;
  triggers: DiagnosisInput["triggers"];
  severity: Severity | null;
  summary: string | null;
  affectedArea: string | null;
  sha: string | null;
  reasoning: string;
  confidence: number;
  implicatedFiles: string[];
}

const PENDING_COLUMNS = {
  id: anomalies.id,
  service: anomalies.service,
  windowStart: anomalies.windowStart,
  windowEnd: anomalies.windowEnd,
  triggers: anomalies.triggers,
  severity: anomalies.severity,
  summary: anomalies.summary,
  affectedArea: anomalies.affectedArea,
  sha: correlations.suspectedCommitSha,
  reasoning: correlations.reasoning,
  confidence: correlations.confidence,
  implicatedFiles: correlations.implicatedFiles,
};

/**
 * Attributed incidents with no hypothesis yet, oldest first.
 *
 * Keyed off the absence of a row rather than a status value, for the same
 * reason Tier 2 keys off `severity IS NULL` and Phase 3 off the absence of a
 * correlation: a status a later phase moves would otherwise cause silent
 * re-work.
 */
async function loadPending(options: DiagnoseOptions): Promise<PendingDiagnosis[]> {
  const alreadyDiagnosed = db.select({ id: hypotheses.anomalyId }).from(hypotheses);

  const base = db
    .select(PENDING_COLUMNS)
    .from(anomalies)
    .innerJoin(correlations, eq(correlations.anomalyId, anomalies.id));

  if (options.anomalyId) {
    return base.where(eq(anomalies.id, options.anomalyId)) as Promise<PendingDiagnosis[]>;
  }

  return base
    .where(
      and(
        eq(anomalies.isRealIncident, true),
        // A declined correlation has no commit, so there is no diff to reason
        // from. See the header on why that is a scoping decision.
        sql`${correlations.suspectedCommitSha} is not null`,
        notInArray(anomalies.id, alreadyDiagnosed),
      ),
    )
    .orderBy(asc(anomalies.detectedAt))
    .limit(options.limit ?? 10) as Promise<PendingDiagnosis[]>;
}

export async function buildDiagnosisInput(
  pending: PendingDiagnosis,
  commit: CandidateCommit,
): Promise<DiagnosisInput> {
  if (pending.severity === null || pending.summary === null) {
    throw new Error(
      `anomaly ${pending.id} has not been classified — run \`pnpm classify\` first`,
    );
  }

  return {
    service: pending.service,
    windowStart: pending.windowStart,
    windowEnd: pending.windowEnd,
    triggers: pending.triggers,
    severity: pending.severity,
    summary: pending.summary,
    affectedArea: pending.affectedArea ?? "unknown",
    commit,
    correlationReasoning: pending.reasoning,
    correlationConfidence: pending.confidence,
    implicatedFiles: pending.implicatedFiles,
  };
}

/**
 * Persist the hypothesis. `applied` is left at its default of false and is
 * never set by this code — the agent diagnoses, a human decides.
 */
async function persistHypothesis(anomalyId: string, hypothesis: Hypothesis): Promise<void> {
  await db.insert(hypotheses).values({
    anomalyId,
    explainsTheFailure: hypothesis.explainsTheFailure,
    rootCause: hypothesis.rootCause,
    suggestedFix: hypothesis.suggestedFix,
    confidence: hypothesis.confidence,
  });

  await db.update(anomalies).set({ status: "diagnosed" }).where(eq(anomalies.id, anomalyId));
}

export async function diagnoseAnomalies(
  options: DiagnoseOptions = {},
): Promise<DiagnosisRunResult> {
  const provider = options.provider ?? createProvider();
  const pending = await loadPending(options);
  const outcomes: DiagnosisOutcome[] = [];

  for (const incident of pending) {
    try {
      if (incident.sha === null) {
        throw new Error(
          "the correlation for this anomaly named no commit, so there is no diff to diagnose",
        );
      }

      const commit = await commitBySha(incident.sha, options.repoPath);
      if (!commit) {
        throw new Error(
          `commit ${incident.sha.slice(0, 10)} is not in the target repository any more`,
        );
      }

      const input = await buildDiagnosisInput(incident, commit);

      const { value, stats } = await generateStructured({
        provider,
        schema: hypothesisSchema,
        system: ROOT_CAUSE_SYSTEM_PROMPT,
        user: renderDiagnosisContext(input),
        agent: "root_cause",
        anomalyId: incident.id,
        onCall: recordLlmCall,
      });

      await persistHypothesis(incident.id, value);

      outcomes.push({
        anomalyId: incident.id,
        service: incident.service,
        status: "diagnosed",
        sha: incident.sha,
        hypothesis: value,
        stats,
      });
    } catch (error) {
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

export interface DiagnosisFunnel {
  attributed: number;
  diagnosed: number;
  /** Hypotheses whose author judged the diff sufficient. */
  explained: number;
  /** Hypotheses that disagreed with the correlation they were handed. */
  unexplained: number;
  applied: number;
}

/**
 * `unexplained` is reported separately because it is the interesting number: a
 * stage that never disagrees with its input is a stage that is not adding a
 * judgement, and this is the only place that would be visible.
 */
export async function diagnosisFunnel(): Promise<DiagnosisFunnel> {
  const [attributed] = await db
    .select({
      attributed: sql<number>`sum(case when ${correlations.suspectedCommitSha} is not null then 1 else 0 end)`,
    })
    .from(correlations);

  const [rows] = await db
    .select({
      diagnosed: sql<number>`count(*)`,
      explained: sql<number>`sum(case when ${hypotheses.explainsTheFailure} = 1 then 1 else 0 end)`,
      unexplained: sql<number>`sum(case when ${hypotheses.explainsTheFailure} = 0 then 1 else 0 end)`,
      applied: sql<number>`sum(case when ${hypotheses.applied} = 1 then 1 else 0 end)`,
    })
    .from(hypotheses);

  return {
    attributed: attributed?.attributed ?? 0,
    diagnosed: rows?.diagnosed ?? 0,
    explained: rows?.explained ?? 0,
    unexplained: rows?.unexplained ?? 0,
    applied: rows?.applied ?? 0,
  };
}

/** Render the full prompt for an incident without calling anything. */
export async function previewDiagnosisPrompt(
  anomalyId?: string,
  options: DiagnoseOptions = {},
): Promise<string | null> {
  const [incident] = anomalyId
    ? ((await db
        .select(PENDING_COLUMNS)
        .from(anomalies)
        .innerJoin(correlations, eq(correlations.anomalyId, anomalies.id))
        .where(eq(anomalies.id, anomalyId))) as PendingDiagnosis[])
    : ((await db
        .select(PENDING_COLUMNS)
        .from(anomalies)
        .innerJoin(correlations, eq(correlations.anomalyId, anomalies.id))
        .where(sql`${correlations.suspectedCommitSha} is not null`)
        .orderBy(desc(anomalies.detectedAt))
        .limit(1)) as PendingDiagnosis[]);

  if (!incident || incident.sha === null) return null;

  const commit = await commitBySha(incident.sha, options.repoPath);
  if (!commit) return null;

  const input = await buildDiagnosisInput(incident, commit);
  return `${ROOT_CAUSE_SYSTEM_PROMPT}\n\n---\n\n${renderDiagnosisContext(input)}`;
}
