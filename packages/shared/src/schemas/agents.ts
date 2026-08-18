/**
 * Structured output contracts for the three LLM-backed agents.
 *
 * WHAT THIS FILE DOES
 * Defines the exact JSON shape each agent must return, as Zod schemas. Every
 * model response is parsed into one of these before any other code touches it —
 * nothing downstream ever consumes free-form model text. If a model returns
 * something malformed, it is caught here, loudly, at the boundary, rather than
 * three functions later when a field renders as `undefined`.
 *
 * WHAT "AGENT" MEANS IN THIS PROJECT
 * A role that calls an LLM with its own prompt and its own output schema. Three
 * are declared; one is built.
 *
 *   classifier   (Phase 2, built)   Is this flagged window a real incident,
 *                                   how bad, and where? → `classificationSchema`
 *   correlator   (Phase 3)          Which recent commit most likely caused it?
 *                                   → `correlationSchema`
 *   root_cause   (Phase 4)          Why did it break and what is the fix?
 *                                   → `hypothesisSchema`
 *
 * Separate prompts and schemas per role rather than one mega-prompt: cheaper,
 * independently evaluable, and each one's spend is attributable in `llm_calls`.
 *
 * WHAT IT EXPORTS
 *   - `classificationSchema`  severity, summary, isRealIncident, affectedArea
 *   - `correlationSchema`     suspected sha (nullable), confidence, reasoning,
 *                             implicated files
 *   - `hypothesisSchema`      root cause, suggested fix, confidence
 *   - `llmAgents` / `llmAgentSchema`   the three agent names
 *   - `llmCallStatsSchema`    per-call cost and latency record
 *
 * NOTES ON PARTICULAR FIELDS
 * `isRealIncident` is the judgement statistics cannot make. Deploy restarts and
 * scheduled batch jobs look identical to an outage on a graph; they do not look
 * identical in the log text.
 *
 * `suspectedCommitSha` is nullable on purpose — "no candidate commit explains
 * this" is a real answer, and a model with no null available will invent one.
 *
 * `llmCallStatsSchema.repairAttempts` counts how many times a response failed
 * validation and had to be re-prompted. Recording it means a model that only
 * produces valid output on the third try is visibly worse than one that gets it
 * right first time, rather than looking identical in the cost table.
 */

import { z } from "zod";
import { severitySchema } from "./anomaly";

/** Tier 2: does this candidate represent a real incident, and how bad? */
export const classificationSchema = z.object({
  severity: severitySchema,
  /** One or two sentences, plain English, no jargon. */
  summary: z.string().min(10).max(1000),
  /**
   * The judgement statistics cannot make. Deploy restarts and scheduled
   * batch jobs look identical to an outage on a graph; they do not look
   * identical in the log text.
   */
  isRealIncident: z.boolean(),
  affectedArea: z.string().max(200),
});

export type Classification = z.infer<typeof classificationSchema>;

/**
 * Correlation agent: reason across runtime behaviour and source history to
 * pick the commit most likely responsible. This is the step that makes the
 * system agentic rather than a wrapper — two independent data sources, one
 * causal conclusion.
 */
export const correlationSchema = z.object({
  /** Null when no candidate commit plausibly explains the anomaly. */
  suspectedCommitSha: z.string().min(7).max(40).nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(10).max(2000),
  changedFilesImplicated: z.array(z.string().max(400)).max(50),
});

export type Correlation = z.infer<typeof correlationSchema>;

/** Root-cause agent: the human-readable answer, plus a proposed fix. */
export const hypothesisSchema = z.object({
  rootCause: z.string().min(10).max(2000),
  suggestedFix: z.string().min(10).max(4000),
  /** How sure the model is that this explains the observed behaviour. */
  confidence: z.number().min(0).max(1),
});

export type Hypothesis = z.infer<typeof hypothesisSchema>;

/**
 * The three LLM-backed agents. Every call records which one asked, so cost can
 * be attributed per stage rather than reported as one undifferentiated total.
 */
export const llmAgents = ["classifier", "correlator", "root_cause"] as const;
export type LlmAgent = (typeof llmAgents)[number];
export const llmAgentSchema = z.enum(llmAgents);

/**
 * Per-call cost and latency, recorded for every LLM invocation.
 *
 * This is what lets us make the claim the whole two-tier design exists to
 * support: the LLM fires on only a small fraction of windows, and here are
 * the numbers.
 */
export const llmCallStatsSchema = z.object({
  provider: z.string(),
  model: z.string(),
  agent: llmAgentSchema,
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  latencyMs: z.number().nonnegative(),
  /** How many times the output failed Zod validation and had to be retried. */
  repairAttempts: z.number().int().nonnegative(),
  succeeded: z.boolean(),
});

export type LlmCallStats = z.infer<typeof llmCallStatsSchema>;
