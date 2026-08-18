/**
 * One implementation for the three providers that speak OpenAI's
 * `/chat/completions`.
 *
 * WHAT THIS FILE DOES
 * `createOpenAiCompatibleProvider` is a factory parameterised by name, base URL,
 * model, API key and extra headers. It serves:
 *
 *   nvidia      NVIDIA NIM, free developer tier
 *   openrouter  free `:free` model variants, used for model comparison
 *   ollama      local, no key at all
 *
 * WHY ONE FILE AND NOT THREE
 * These providers differ in base URL, auth header, and which models exist —
 * NOT in wire format. Three near-identical files expressing that would be
 * duplication pretending to be architecture. Adding a fourth OpenAI-compatible
 * vendor is a few lines in `index.ts`, not a new file.
 *
 * TWO NON-OBVIOUS DETAILS
 *
 * 1. OpenRouter returns UPSTREAM FAILURES AS HTTP 200 with an `error` field in
 *    the body. Without an explicit check for that field, those surface two
 *    layers up as an unhelpful "response was not valid JSON" and send you
 *    looking in the wrong place entirely.
 *
 * 2. `response_format: { type: "json_object" }` is sent UNCONDITIONALLY.
 *    Support varies across the three, and a provider that ignores the field
 *    simply returns ordinary text — which the extractor and the repair loop
 *    already handle. That is what makes it safe to send everywhere rather than
 *    maintaining a capability matrix that would drift out of date.
 *
 * `parseChatCompletion` is exported for tests: response parsing is where the
 * edge cases live, and it needs no network to exercise.
 */

import { postJson } from "../http";
import { LlmProviderError, type LlmCompletion, type LlmProvider, type LlmRequest } from "../types";

interface ChatCompletionResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/** Exported for tests. */
export function parseChatCompletion(
  raw: unknown,
  provider: string,
  model: string,
): LlmCompletion {
  const response = raw as ChatCompletionResponse;

  /**
   * OpenRouter in particular returns upstream failures as HTTP 200 with an
   * `error` field. Without this check they surface as an unhelpful JSON parse
   * error two layers up.
   */
  if (response.error) {
    throw new LlmProviderError(
      `${provider}: ${response.error.message ?? "upstream error"}`,
      provider,
    );
  }

  const choice = response.choices?.[0];
  const text = choice?.message?.content ?? "";

  if (!text) {
    throw new LlmProviderError(
      `${provider}: empty completion (finish_reason: ${choice?.finish_reason ?? "unknown"})`,
      provider,
    );
  }

  return {
    text,
    model,
    inputTokens: response.usage?.prompt_tokens ?? null,
    outputTokens: response.usage?.completion_tokens ?? null,
  };
}

export interface OpenAiCompatibleOptions {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Extra headers. OpenRouter uses these for attribution on free models. */
  headers?: Record<string, string>;
}

export function createOpenAiCompatibleProvider(
  options: OpenAiCompatibleOptions,
): LlmProvider {
  const { name, baseUrl, model, apiKey, headers = {} } = options;

  return {
    name,
    model,
    async complete(request: LlmRequest): Promise<LlmCompletion> {
      const raw = await postJson({
        url: `${baseUrl.replace(/\/$/, "")}/chat/completions`,
        headers: {
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...headers,
        },
        provider: name,
        body: {
          model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          temperature: request.temperature,
          max_tokens: request.maxOutputTokens,
          /**
           * Best-effort JSON mode. Support varies across these three and a
           * provider that ignores the field simply returns ordinary text —
           * which the extractor and the repair loop already handle. That is
           * why this is safe to send unconditionally.
           */
          response_format: { type: "json_object" },
        },
      });

      return parseChatCompletion(raw, name, model);
    },
  };
}
