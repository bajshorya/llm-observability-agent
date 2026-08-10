import type { LlmProviderName } from "../env";

/**
 * LLM tunables, in one place for the same reason the detection thresholds are:
 * so the cost and reliability behaviour of the system can be reasoned about
 * without reading five files.
 */
export const llmConfig = {
  /**
   * Classification is a judgement, not a composition. Near-zero temperature
   * keeps the same window classifying the same way across runs, which is what
   * makes the eval harness meaningful and the demo repeatable.
   */
  temperature: 0.1,

  /**
   * The classifier's answer is four short fields. This is a guard against a
   * model that decides to narrate, not a budget we expect to use.
   */
  maxOutputTokens: 800,

  /** Per-attempt HTTP timeout. Free tiers can be slow; they should not hang. */
  timeoutMs: 45_000,

  /**
   * Transport-level retries per attempt, for 429s and 5xxs. Free tiers rate
   * limit aggressively, and a 429 is a reason to wait rather than to fail the
   * anomaly.
   */
  maxHttpAttempts: 3,

  /**
   * How many times a schema-invalid response is fed back to the model with its
   * validation errors before we give up.
   *
   * Two is a deliberate ceiling. A model that cannot produce the shape twice
   * in a row is not going to produce it on the fifth try, and each retry costs
   * real tokens — the cost table would quietly fill with them.
   */
  maxRepairAttempts: 2,
} as const;

export type LlmConfig = typeof llmConfig;

/**
 * Default model per provider. All of these sit on a free tier.
 *
 * Model identifiers on free tiers are churn-prone — providers retire and
 * rename them. `LLM_MODEL` overrides any of these without a code change, which
 * is the intended fix when one of them 404s.
 */
export const defaultModels: Record<LlmProviderName, string> = {
  gemini: "gemini-2.5-flash",
  nvidia: "meta/llama-3.3-70b-instruct",
  openrouter: "meta-llama/llama-3.3-70b-instruct:free",
  ollama: "llama3.1:8b",
  stub: "deterministic-stub",
};

/** OpenAI-compatible base URLs. Ollama's comes from the environment. */
export const openAiCompatibleBaseUrls = {
  nvidia: "https://integrate.api.nvidia.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
} as const;
