/**
 * LLM tunables and default models.
 *
 * WHAT THIS FILE DOES
 * Holds every number governing how the model is called — temperature, output
 * ceiling, timeouts, retry and repair limits — plus the default model for each
 * provider and the OpenAI-compatible base URLs.
 *
 * In one place for the same reason the detection thresholds are: the cost and
 * reliability behaviour of the system is the sum of these values, and they
 * cannot be reasoned about while scattered across five files.
 *
 * THE VALUES, AND WHY
 *   temperature 0.1        Classification is a judgement, not a composition.
 *                          The same window must classify the same way twice, or
 *                          the eval harness measures noise instead of quality.
 *   maxOutputTokens 800    The answer is four short fields. This is a guard
 *                          against a model that decides to narrate, not a
 *                          budget we expect to use.
 *   timeoutMs 45000        Free tiers are slow. They should not hang.
 *   maxHttpAttempts 3      429s are the steady state of a free tier.
 *   maxRepairAttempts 2    A model that cannot produce the schema twice will
 *                          not produce it on the fifth try, and every retry
 *                          costs real tokens.
 *
 * THE DEFAULT MODELS
 * All sit on a free tier. The Gemini default is a MEASURED choice, not a
 * preference: it scores 6/6 on the golden set where the previous default scored
 * 1/3 on the benign half. See `eval/` and DOCUMENTATION-EVALS.md §10.
 *
 * Free-tier model identifiers churn — providers retire and rename them — so
 * `LLM_MODEL` overrides any of these without a code change. That is the
 * intended fix when one starts returning 404, and it is also how to get past a
 * 429, since quota is bucketed per model.
 */

import type { LlmProviderName } from "../env";
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
  /**
   * Scores 6/6 on the golden set — every verdict, every severity exact,
   * every area grounded — stably across repeated runs. `gemini-2.5-flash`
   * was the previous default and manages 1/3 on the benign half, so this is
   * a measured choice rather than a preference for the larger number.
   *
   * It is roughly five times slower per call (~22s against ~5s). For a stage
   * that runs on anomalies rather than in a request path, that is a good
   * trade; if it ever stops being one, `LLM_MODEL` changes it without a
   * deploy.
   */
  gemini: "gemini-3.5-flash",
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
