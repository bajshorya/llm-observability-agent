import type { LlmAgent } from "@obs/shared";

/**
 * The provider boundary.
 *
 * Everything above this line — prompts, repair loops, cost accounting — is
 * provider-agnostic. Everything below it is one file per vendor whose only job
 * is to turn this request into that vendor's HTTP shape and turn the response
 * back into `LlmCompletion`.
 *
 * The interface is deliberately one method wide. Streaming, tool calling and
 * multi-turn conversation are all things this system does not need: every
 * agent here asks one question and parses one JSON answer. Adding surface for
 * capabilities we do not use would mean every new provider has to implement
 * them.
 */

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
