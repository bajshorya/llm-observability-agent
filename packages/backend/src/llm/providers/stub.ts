import type { TriggerKind } from "@obs/shared";
import { LlmProviderError, type LlmCompletion, type LlmProvider, type LlmRequest } from "../types";

/**
 * A deterministic provider that makes no network call.
 *
 * This is the default, and it is not only a test fixture. It means the full
 * pipeline — detect, classify, persist, report — runs end to end for someone
 * who has cloned the repo and has no API key, and it means the unit tests
 * exercise the real prompt-to-persistence path instead of a mock of it.
 *
 * It is a stub, not a model: its severity comes from counting which detectors
 * fired, which is exactly the judgement Tier 2 exists to improve on. Its
 * summaries say so rather than impersonating a model's prose, because a stub
 * output that reads like a real one is a stub that will eventually be mistaken
 * for one.
 */

/**
 * Weight per signal. A brand-new error signature and an error-rate spike are
 * each strong evidence; a latency jump alone is more often load than breakage.
 */
const TRIGGER_WEIGHTS: Record<TriggerKind, number> = {
  new_error_signature: 2,
  error_rate_spike: 2,
  latency_jump: 1,
};

/** Marker lines the context renderer emits. See classification/context.ts. */
const SERVICE_LINE = /^Service:\s*(.+)$/m;
const TRIGGER_LINE = /^Triggers fired:\s*(.+)$/m;

function severityFor(score: number): string {
  if (score >= 4) return "critical";
  if (score >= 3) return "high";
  if (score >= 2) return "medium";
  return "low";
}

function classify(user: string): string {
  const service = SERVICE_LINE.exec(user)?.[1]?.trim() ?? "unknown service";
  const kinds = (TRIGGER_LINE.exec(user)?.[1] ?? "")
    .split(",")
    .map((kind) => kind.trim())
    .filter((kind): kind is TriggerKind => kind in TRIGGER_WEIGHTS);

  const score = kinds.reduce((total, kind) => total + TRIGGER_WEIGHTS[kind], 0);

  return JSON.stringify({
    severity: severityFor(score),
    summary:
      `Stub classification for ${service}: ${kinds.length} Tier 1 signal(s) fired ` +
      `(${kinds.join(", ") || "none"}). Severity is scored from which detectors ` +
      `tripped — no model was called. Set LLM_PROVIDER to classify for real.`,
    // Two independent signals is the threshold at which the statistics alone
    // are worth a human's attention.
    isRealIncident: score >= 2,
    affectedArea: service,
  });
}

export function createStubProvider(): LlmProvider {
  return {
    name: "stub",
    model: "deterministic-stub",
    complete(request: LlmRequest): Promise<LlmCompletion> {
      if (request.agent !== "classifier") {
        throw new LlmProviderError(
          `stub: no canned response for the ${request.agent} agent yet`,
          "stub",
        );
      }

      return Promise.resolve({
        text: classify(request.user),
        model: "deterministic-stub",
        /**
         * Null rather than an estimate. The cost table is evidence for a claim
         * about real spend; putting invented numbers in it would make every
         * number in it worth less.
         */
        inputTokens: null,
        outputTokens: null,
      });
    },
  };
}
