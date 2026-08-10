import { postJson } from "../http";
import { LlmProviderError, type LlmCompletion, type LlmProvider, type LlmRequest } from "../types";

/**
 * Google AI Studio (Gemini) — the primary provider. Free tier, no card.
 *
 * Uses the native `generateContent` API rather than Google's OpenAI-compatible
 * shim, because two things we want are only on the native surface:
 * `responseMimeType: "application/json"`, and the ability to switch the 2.5
 * models' thinking off.
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
}

/** Exported for tests: response parsing is the part with edge cases. */
export function parseGeminiResponse(raw: unknown, model: string): LlmCompletion {
  const response = raw as GeminiResponse;

  if (response.promptFeedback?.blockReason) {
    throw new LlmProviderError(
      `gemini: prompt blocked (${response.promptFeedback.blockReason})`,
      "gemini",
    );
  }

  const candidate = response.candidates?.[0];
  const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";

  if (!text) {
    /**
     * An empty candidate with `finishReason: MAX_TOKENS` is the classic
     * thinking-budget failure — the model spent the entire output allowance
     * reasoning and emitted nothing. Naming it here saves the next person an
     * hour, since the symptom otherwise looks like a parse bug.
     */
    throw new LlmProviderError(
      `gemini: empty completion (finishReason: ${candidate?.finishReason ?? "unknown"})`,
      "gemini",
    );
  }

  return {
    text,
    model,
    inputTokens: response.usageMetadata?.promptTokenCount ?? null,
    outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
  };
}

export function createGeminiProvider(apiKey: string, model: string): LlmProvider {
  return {
    name: "gemini",
    model,
    async complete(request: LlmRequest): Promise<LlmCompletion> {
      const raw = await postJson({
        url: `${API_BASE}/${model}:generateContent`,
        headers: { "x-goog-api-key": apiKey },
        provider: "gemini",
        body: {
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: "user", parts: [{ text: request.user }] }],
          generationConfig: {
            temperature: request.temperature,
            maxOutputTokens: request.maxOutputTokens,
            /**
             * JSON mode. This does not replace Zod validation — it constrains
             * syntax, not semantics, so a model can still return valid JSON
             * with a severity of "quite bad". It does remove the most common
             * failure, which is a JSON object wrapped in prose.
             */
            responseMimeType: "application/json",
            /**
             * Thinking off. On 2.5 models reasoning tokens are billed against
             * `maxOutputTokens`, so a thinking budget can consume the entire
             * allowance and return an empty candidate. Classification is a
             * short structured judgement over evidence we have already
             * assembled — there is nothing here worth thinking tokens.
             */
            thinkingConfig: { thinkingBudget: 0 },
          },
        },
      });

      return parseGeminiResponse(raw, model);
    },
  };
}
