/**
 * The deterministic stub provider — the default, and the experimental control.
 *
 * WHAT THIS FILE DOES
 * Implements `LlmProvider` with no network call at all. It parses the rendered
 * evidence packet for two marker lines, scores severity by counting which
 * detectors fired, and returns valid `classificationSchema` JSON.
 *
 * WHY IT IS THE DEFAULT
 * Three reasons, and none of them is "for tests":
 *   1. The full pipeline — detect, classify, persist, report — runs end to end
 *      for someone who has just cloned the repo and has no API key.
 *   2. The unit tests exercise the REAL prompt-to-persistence path rather than
 *      a mock of it; only the model itself is substituted.
 *   3. `pnpm test` needs no network and costs nothing.
 *
 * WHY ITS SCORING IS DELIBERATELY CRUDE
 * It weights new_error_signature and error_rate_spike at 2, latency_jump at 1,
 * and calls anything scoring 2+ a real incident. That is precisely the
 * STATISTICAL judgement — the thing Tier 2 exists to improve on — rather than a
 * simulation of a semantic one.
 *
 * This makes it the control in the eval. It scores 0/3 on the benign half,
 * because those windows are statistically indistinguishable from real
 * incidents by construction. That 0/3 is not a deficiency to fix; it is the
 * number that makes the whole two-tier claim falsifiable, and the gap between
 * it and a real model's 3/3 is the measured value of the LLM tier.
 *
 * WHY THE SUMMARIES ANNOUNCE THEMSELVES
 * They say "Stub classification… no model was called" rather than impersonating
 * a model's prose. A stub whose output reads like the real thing is a stub that
 * will eventually be mistaken for one — in a screenshot, a demo, or a
 * README — and that is a very expensive kind of confusion.
 *
 * Token counts are null rather than estimated, for the same reason: the cost
 * table is evidence, and inventing numbers for it devalues the real ones.
 *
 * COUPLING WORTH KNOWING
 * It parses `Service:` and `Triggers fired:` out of the rendered context, so
 * those two lines in `classification/context.ts` are load-bearing beyond
 * readability. Both files say so.
 */

import type { TriggerKind } from "@obs/shared";
import { LlmProviderError, type LlmCompletion, type LlmProvider, type LlmRequest } from "../types";

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
