/**
 * The provider boundary — the entire contract between this system and any LLM.
 *
 * WHAT THIS FILE DOES
 * Defines four types and one error class. It is the narrowest and most
 * important file in the `llm` package: everything ABOVE this line — prompts,
 * the repair loop, cost accounting — is provider-agnostic, and everything BELOW
 * it is one file per vendor whose only job is to turn an `LlmRequest` into that
 * vendor's HTTP shape and turn the response back into an `LlmCompletion`.
 *
 *     classifier / correlator / root_cause      ← provider-agnostic
 *              │
 *          structured.ts  (schema + repair)     ← provider-agnostic
 *              │
 *     ┌────────┴─────────┐  LlmProvider          ← THIS FILE
 *     │                  │
 *   gemini.ts    openai-compatible.ts / stub.ts  ← vendor-specific
 *
 * THE INTERFACE IS ONE METHOD WIDE, ON PURPOSE
 *
 *     complete(request: LlmRequest): Promise<LlmCompletion>
 *
 * Streaming, tool calling and multi-turn conversation are all absent because no
 * agent in this system needs them — each asks one question and parses one JSON
 * answer. Surface for capabilities we do not use is surface every new provider
 * would have to implement, so adding a provider stays a one-file job.
 *
 * WHY TOKEN COUNTS ARE NULLABLE
 * Not every provider reports usage, and a missing token count is not a reason
 * to fail a classification. The cost table records what it knows rather than
 * inventing the rest — an estimate in a table whose purpose is substantiating a
 * cost claim would devalue every real number in it.
 *
 * `temperature` and `maxOutputTokens` are required rather than optional so a
 * provider can never silently fall back to a vendor default, which would make
 * runs non-reproducible in a way that is very hard to notice.
 */

import type { LlmAgent } from "@obs/shared";

export interface LlmRequest {
  /** Role and output contract. Stable across calls, so it caches well. */
  system: string;
  /** The evidence for this specific call. */
  user: string;
  /** Which agent is asking. Recorded for cost attribution. */
  agent: LlmAgent;
  /**
   * Low by default. We want repeatable judgements, not creativity — the same
   * anomaly classified twice should not produce two different severities.
   */
  temperature: number;
  maxOutputTokens: number;
}

export interface LlmCompletion {
  /** Raw model text. Parsing and validation happen above the provider. */
  text: string;
  model: string;
  /**
   * Nullable because not every provider reports usage, and a missing token
   * count is not a reason to fail a call. The cost table records what it knows
   * rather than guessing.
   */
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmCompletion>;
}

/** Thrown for a call that failed at the transport or protocol level. */
export class LlmProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmProviderError";
  }
}
