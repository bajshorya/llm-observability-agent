/**
 * Google AI Studio (Gemini) — the primary provider.
 *
 * WHAT THIS FILE DOES
 * Implements `LlmProvider` against Gemini's native `generateContent` endpoint:
 * builds the request body, posts it via the shared HTTP helper, and parses the
 * response into an `LlmCompletion`. Free tier, no credit card.
 *
 * WHY THE NATIVE API RATHER THAN GOOGLE'S OpenAI-COMPATIBLE SHIM
 * Two things we want exist only on the native surface.
 * 
 * 1. `responseMimeType: "application/json"` — JSON mode. This constrains
 *    SYNTAX, not semantics: a model can still return perfectly valid JSON with
 *    a severity of "quite bad", which is why Zod validation stays regardless.
 *    What it removes is the most common failure — a correct object wrapped in a
 *    sentence of prose.
 *
 * 2. `thinkingConfig: { thinkingBudget: 0 }` — and this one is not optional.
 *    On 2.5-generation models, reasoning tokens are billed against
 *    `maxOutputTokens`. Leave thinking enabled with an 800-token ceiling and
 *    the model can spend the entire allowance reasoning and return an EMPTY
 *    candidate with `finishReason: MAX_TOKENS`. The symptom looks exactly like
 *    a parse bug, which is why `parseGeminiResponse` names the finish reason in
 *    its error rather than just reporting "empty completion". Classification is
 *    a short structured judgement over evidence already assembled — there is
 *    nothing here worth thinking tokens.
 *
 * RESPONSE PARSING
 * `parseGeminiResponse` is exported separately because response handling is
 * where the edge cases live and it is worth being able to test without a
 * network. It checks `promptFeedback.blockReason` first — a safety block
 * returns no candidate at all, and reporting that as "empty completion" would
 * send someone hunting for the wrong bug.
 *
 * QUOTA NOTE
 * Free-tier quota is bucketed PER MODEL. When one model returns 429 for the
 * day, `LLM_MODEL` pointing at a different one is the way through.
 */

import { postJson } from "../http";
import { LlmProviderError, type LlmCompletion, type LlmProvider, type LlmRequest } from "../types";

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
