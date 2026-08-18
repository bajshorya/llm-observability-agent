/**
 * The provider factory, and the package's public entry point.
 *
 * WHAT THIS FILE DOES
 * `createProvider(name?)` resolves a provider from the environment and returns
 * something implementing `LlmProvider`. It also re-exports the types and
 * functions the rest of the backend needs, so callers import from `../llm`
 * rather than reaching into individual files.
 *
 * THE FIVE PROVIDERS
 *   stub        DEFAULT. Deterministic, offline, no account. The whole
 *               pipeline and the entire test suite run without a key.
 *   gemini      Primary. Native API, JSON mode, thinking disabled.
 *   nvidia      Backup, OpenAI-compatible.
 *   openrouter  Model comparison for the eval harness, OpenAI-compatible.
 *   ollama      Local, no key at all, OpenAI-compatible.
 *
 * Model selection is `LLM_MODEL` if set, otherwise the provider's default from
 * `config.ts`.
 *
 * WHY A MISSING KEY FAILS HERE
 * `requireKey` throws at CONSTRUCTION with the name of the variable to set:
 *
 *     LLM_PROVIDER=gemini requires GEMINI_API_KEY. Set it in .env, or use
 *     LLM_PROVIDER=stub to run without a key.
 *
 * rather than surfacing as an HTTP 401 halfway through a classification run.
 * The distinction matters when the run is unattended and has already spent
 * quota on the anomalies it processed before reaching the broken one.
 *
 * The switch is exhaustive over `LlmProviderName`, so adding a provider to that
 * union fails compilation here until it is handled — the factory cannot
 * silently fall through to a default.
 */

import { env, type LlmProviderName } from "../env";
import { defaultModels, openAiCompatibleBaseUrls } from "./config";
import { createGeminiProvider } from "./providers/gemini";
import { createOpenAiCompatibleProvider } from "./providers/openai-compatible";
import { createStubProvider } from "./providers/stub";
import type { LlmProvider } from "./types";

export type { LlmCompletion, LlmProvider, LlmRequest } from "./types";
export { LlmProviderError } from "./types";
export { generateStructured, LlmStructuredError } from "./structured";

/** Throws with the variable name to set, rather than deferring to a 401. */
function requireKey(value: string | undefined, variable: string, provider: string): string {
  if (!value) {
    throw new Error(
      `LLM_PROVIDER=${provider} requires ${variable}. Set it in .env, or use LLM_PROVIDER=stub to run without a key.`,
    );
  }
  return value;
}

export function createProvider(name: LlmProviderName = env.LLM_PROVIDER): LlmProvider {
  const model = env.LLM_MODEL ?? defaultModels[name];

  switch (name) {
    case "gemini":
      return createGeminiProvider(
        requireKey(env.GEMINI_API_KEY, "GEMINI_API_KEY", name),
        model,
      );

    case "nvidia":
      return createOpenAiCompatibleProvider({
        name,
        baseUrl: openAiCompatibleBaseUrls.nvidia,
        model,
        apiKey: requireKey(env.NVIDIA_API_KEY, "NVIDIA_API_KEY", name),
      });

    case "openrouter":
      return createOpenAiCompatibleProvider({
        name,
        baseUrl: openAiCompatibleBaseUrls.openrouter,
        model,
        apiKey: requireKey(env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY", name),
        headers: {
          "http-referer": "https://github.com/observability-agent",
          "x-title": "Observability Agent",
        },
      });

    case "ollama":
      // Local, so no key — the only provider that works with no account at all.
      return createOpenAiCompatibleProvider({
        name,
        baseUrl: `${env.OLLAMA_BASE_URL.replace(/\/$/, "")}/v1`,
        model,
      });

    case "stub":
      return createStubProvider();
  }
}
