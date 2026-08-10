import { z } from "zod";
import { severitySchema } from "./anomaly";

/**
 * Structured output contracts for the three LLM-backed agents.
 *
 * Every model response is parsed into one of these before any other code
 * touches it. Nothing downstream consumes free-form text. If a model returns
 * something malformed we find out here — loudly, at the boundary — rather
 * than three functions later when a field renders as `undefined`.
 */

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
