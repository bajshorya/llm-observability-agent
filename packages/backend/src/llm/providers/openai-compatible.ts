import { postJson } from "../http";
import { LlmProviderError, type LlmCompletion, type LlmProvider, type LlmRequest } from "../types";

/**
 * One implementation for the three providers that speak OpenAI's
 * `/chat/completions`: NVIDIA NIM, OpenRouter, and Ollama.
 *
 * They differ in base URL, auth header and which models exist — not in wire
 * format. Writing three near-identical files to express that would be
 * duplication pretending to be architecture.
 */

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
