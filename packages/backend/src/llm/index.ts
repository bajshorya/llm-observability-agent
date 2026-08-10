import { env, type LlmProviderName } from "../env";
import { defaultModels, openAiCompatibleBaseUrls } from "./config";
import { createGeminiProvider } from "./providers/gemini";
import { createOpenAiCompatibleProvider } from "./providers/openai-compatible";
import { createStubProvider } from "./providers/stub";
import type { LlmProvider } from "./types";

export type { LlmCompletion, LlmProvider, LlmRequest } from "./types";
export { LlmProviderError } from "./types";
export { generateStructured, LlmStructuredError } from "./structured";

/**
 * Provider selection, resolved once from the environment.
 *
 * A missing key fails here — at construction, with the name of the variable to
 * set — rather than on the first HTTP 401 halfway through a classification
 * run. The distinction matters when the run is unattended.
 */
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
