/**
 * Tests for JSON extraction, the repair loop, and the stub provider.
 *
 * WHAT THIS FILE COVERS
 * The whole path from a raw model response to a schema-valid object, with no
 * network involved. A fake provider replays canned responses — including
 * malformed ones and thrown errors — so every branch of the repair loop can be
 * exercised deterministically.
 *
 * WHAT IT PINS DOWN
 *
 *   JSON extraction   fenced output, prose preamble, and the case that breaks
 *                     the naive implementation: a brace inside a quoted error
 *                     message. Truncated output must return null rather than a
 *                     half-parse.
 *
 *   The repair loop   a schema-invalid response is re-prompted; the repair
 *                     prompt must contain the model's OWN OUTPUT and name the
 *                     offending field, because "that was invalid" without
 *                     showing what "that" was produces a second guess rather
 *                     than a correction.
 *
 *   Cost accounting   tokens summed across attempts; a failed run still
 *                     records a row, because it still spent quota.
 *
 *   Transport errors  must NOT enter the repair loop. Re-prompting cannot fix
 *                     a bad API key, so exactly one attempt is made.
 *
 *   The stub          produces schema-valid output with no network, and refuses
 *                     agents it has no canned answer for rather than returning
 *                     something plausible-looking.
 *
 * THEY RUN AGAINST THE REAL `llmConfig`, matching the detector tests: a change
 * to the repair ceiling should fail here rather than quietly alter how much a
 * failing model costs.
 *
 * NO DATABASE IS INVOLVED, because `generateStructured` takes an injected cost
 * sink rather than importing one. The tests pass an array and inspect it.
 */

import { describe, expect, it } from "vitest";
import { classificationSchema } from "@obs/shared";
import { llmConfig } from "./config";
import { extractJsonObject, parseJsonObject } from "./json";
import { createStubProvider } from "./providers/stub";
import { generateStructured, LlmStructuredError, type LlmCallRecord } from "./structured";
import { LlmProviderError, type LlmCompletion, type LlmProvider, type LlmRequest } from "./types";

const VALID_RESPONSE = JSON.stringify({
  severity: "high",
  summary: "Checkout is failing with null dereferences on the order total.",
  isRealIncident: true,
  affectedArea: "POST /orders",
});

interface FakeProvider extends LlmProvider {
  requests: LlmRequest[];
}

/** Replays canned responses; throws if asked for more than it was given. */
function fakeProvider(responses: readonly (string | Error)[]): FakeProvider {
  const queue = [...responses];
  const requests: LlmRequest[] = [];

  return {
    name: "fake",
    model: "fake-model",
    requests,
    complete(request: LlmRequest): Promise<LlmCompletion> {
      requests.push(request);
      const next = queue.shift();
      if (next === undefined) throw new Error("fake provider called more times than expected");
      if (next instanceof Error) throw next;
      return Promise.resolve({
        text: next,
        model: "fake-model",
        inputTokens: 100,
        outputTokens: 20,
      });
    },
  };
}

function collectCalls(): { sink: (record: LlmCallRecord) => void; records: LlmCallRecord[] } {
  const records: LlmCallRecord[] = [];
  return { sink: (record) => void records.push(record), records };
}

function run(provider: LlmProvider, sink: (record: LlmCallRecord) => void) {
  return generateStructured({
    provider,
    schema: classificationSchema,
    system: "system prompt",
    user: "Service: orders-api",
    agent: "classifier",
    anomalyId: "anomaly-1",
    onCall: sink,
  });
}

describe("extractJsonObject", () => {
  it("returns a bare object unchanged", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it("unwraps a markdown fence", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("ignores prose before and after the object", () => {
    expect(extractJsonObject('Sure! Here it is:\n{"a":1}\nHope that helps.')).toBe('{"a":1}');
  });

  it("does not end the object on a brace inside a string", () => {
    // Exactly the error text this system exists to classify.
    const text = '{"summary":"Cannot read properties of null (reading \'{}\')","ok":true}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it("survives an escaped quote inside a string", () => {
    const text = '{"summary":"he said \\"boom\\"","ok":true}';
    expect(parseJsonObject(text)).toEqual({ summary: 'he said "boom"', ok: true });
  });

  it("returns null for truncated output", () => {
    expect(extractJsonObject('{"a":1')).toBeNull();
  });

  it("returns null when there is no object at all", () => {
    expect(extractJsonObject("I cannot help with that.")).toBeNull();
  });
});

describe("generateStructured", () => {
  it("parses a valid first response without repairing", async () => {
    const provider = fakeProvider([VALID_RESPONSE]);
    const { sink, records } = collectCalls();

    const { value, stats } = await run(provider, sink);

    expect(value.severity).toBe("high");
    expect(value.isRealIncident).toBe(true);
    expect(stats.repairAttempts).toBe(0);
    expect(stats.succeeded).toBe(true);
    expect(provider.requests).toHaveLength(1);

    expect(records).toHaveLength(1);
    expect(records[0]?.anomalyId).toBe("anomaly-1");
    expect(records[0]?.agent).toBe("classifier");
  });

  it("repairs a schema-invalid response and reports the attempt", async () => {
    // Valid JSON, invalid severity — the failure Zod exists to catch.
    const invalid = JSON.stringify({
      severity: "quite bad",
      summary: "Something is wrong somewhere.",
      isRealIncident: true,
      affectedArea: "unknown",
    });
    const provider = fakeProvider([invalid, VALID_RESPONSE]);
    const { sink, records } = collectCalls();

    const { value, stats } = await run(provider, sink);

    expect(value.severity).toBe("high");
    expect(stats.repairAttempts).toBe(1);
    expect(stats.succeeded).toBe(true);
    expect(records).toHaveLength(1);
  });

  it("shows the model its own output and the validation error when repairing", async () => {
    const provider = fakeProvider(["not json at all", VALID_RESPONSE]);
    const { sink } = collectCalls();

    await run(provider, sink);

    const repair = provider.requests[1]?.user ?? "";
    expect(repair).toContain("Service: orders-api"); // original evidence retained
    expect(repair).toContain("not json at all");
    expect(repair).toContain("parseable JSON object");
  });

  it("names the offending field in the repair prompt", async () => {
    const provider = fakeProvider([JSON.stringify({ severity: "high" }), VALID_RESPONSE]);
    const { sink } = collectCalls();

    await run(provider, sink);

    expect(provider.requests[1]?.user).toContain("summary");
  });

  it("gives up after the configured repair ceiling", async () => {
    const attempts = llmConfig.maxRepairAttempts + 1;
    const provider = fakeProvider(Array.from({ length: attempts }, () => "still not json"));
    const { sink, records } = collectCalls();

    await expect(run(provider, sink)).rejects.toBeInstanceOf(LlmStructuredError);

    expect(provider.requests).toHaveLength(attempts);
    // The failed call is still recorded — it cost tokens.
    expect(records).toHaveLength(1);
    expect(records[0]?.succeeded).toBe(false);
    expect(records[0]?.repairAttempts).toBe(attempts);
  });

  it("sums token usage across every attempt", async () => {
    const provider = fakeProvider(["not json", VALID_RESPONSE]);
    const { sink } = collectCalls();

    const { stats } = await run(provider, sink);

    expect(stats.inputTokens).toBe(200);
    expect(stats.outputTokens).toBe(40);
  });

  it("does not re-prompt a transport failure, but does record it", async () => {
    const provider = fakeProvider([new LlmProviderError("HTTP 401", "fake", 401)]);
    const { sink, records } = collectCalls();

    await expect(run(provider, sink)).rejects.toBeInstanceOf(LlmProviderError);

    // Re-prompting cannot fix a bad key, so exactly one attempt was made.
    expect(provider.requests).toHaveLength(1);
    expect(records[0]?.succeeded).toBe(false);
    expect(records[0]?.repairAttempts).toBe(0);
  });
});

describe("stub provider", () => {
  const contextFor = (kinds: string) =>
    `Service: orders-api\nTriggers fired: ${kinds}\n`;

  async function classifyWith(kinds: string) {
    const { sink } = collectCalls();
    const { value } = await generateStructured({
      provider: createStubProvider(),
      schema: classificationSchema,
      system: "system",
      user: contextFor(kinds),
      agent: "classifier",
      onCall: sink,
    });
    return value;
  }

  it("produces schema-valid output with no network call", async () => {
    const value = await classifyWith("error_rate_spike, new_error_signature");

    expect(value.severity).toBe("critical");
    expect(value.isRealIncident).toBe(true);
    expect(value.affectedArea).toBe("orders-api");
  });

  it("treats a lone latency jump as weak evidence", async () => {
    const value = await classifyWith("latency_jump");

    expect(value.severity).toBe("low");
    expect(value.isRealIncident).toBe(false);
  });

  it("says in the summary that no model was involved", async () => {
    const value = await classifyWith("error_rate_spike");

    expect(value.summary.toLowerCase()).toContain("stub");
  });

  it("refuses an agent it has no canned answer for", () => {
    // All three declared agents now have one — `correlator` was this test's
    // example until Phase 3, `root_cause` until Phase 4. The guard still
    // matters: it is what makes a fourth agent fail loudly at the stub rather
    // than reaching a provider with a prompt nothing knows how to answer. The
    // cast is deliberate, since the type no longer admits an unhandled name.
    expect(() =>
      createStubProvider().complete({
        system: "s",
        user: "u",
        agent: "remediator" as unknown as "classifier",
        temperature: 0,
        maxOutputTokens: 100,
      }),
    ).toThrow(LlmProviderError);
  });

  it("declines to diagnose rather than inventing a baseline", async () => {
    // Deliberately not a baseline. Classification has a statistical one worth
    // beating and correlation a heuristic one; deriving a mechanism from a
    // diff has no cheap non-model equivalent, so a stub attempt would be a
    // straw man rather than a control.
    const completion = await createStubProvider().complete({
      system: "s",
      user: "u",
      agent: "root_cause",
      temperature: 0,
      maxOutputTokens: 400,
    });

    const value = JSON.parse(completion.text) as {
      explainsTheFailure: boolean;
      rootCause: string;
    };

    expect(value.explainsTheFailure).toBe(false);
    expect(value.rootCause.toLowerCase()).toContain("no model was called");
  });

  /**
   * The correlation baseline. It is deliberately the naive heuristic — blame
   * the newest commit — because that is what you would build without a model,
   * and it is what the fixture history is constructed to defeat.
   */
  const CORRELATION_PACKET = [
    "Candidate commits (2), searched X to Y, newest first:",
    "",
    "  8a38dbc5a4  2026-08-16 18:20Z  42m before  —  ci",
    "    chore(ci): cache the pnpm store between runs",
    "",
    "  0c701a0bcc  2026-08-16 17:25Z  1h 37m before  —  ci",
    "    feat(pricing): show the promotional total",
  ].join("\n");

  async function correlateWith(user: string) {
    const completion = await createStubProvider().complete({
      system: "s",
      user,
      agent: "correlator",
      temperature: 0,
      maxOutputTokens: 200,
    });
    return JSON.parse(completion.text) as {
      suspectedCommitSha: string | null;
      confidence: number;
      reasoning: string;
      changedFilesImplicated: string[];
    };
  }

  it("blames the newest candidate commit", async () => {
    const value = await correlateWith(CORRELATION_PACKET);
    expect(value.suspectedCommitSha).toBe("8a38dbc5a4");
  });

  it("declines when the packet has no candidates", async () => {
    const value = await correlateWith("Candidate commits: NONE.\n  Nothing landed.");
    expect(value.suspectedCommitSha).toBeNull();
  });

  it("names no files, rather than guessing at them", async () => {
    const value = await correlateWith(CORRELATION_PACKET);
    expect(value.changedFilesImplicated).toEqual([]);
  });

  it("says in the reasoning that no model was involved", async () => {
    const value = await correlateWith(CORRELATION_PACKET);
    expect(value.reasoning.toLowerCase()).toContain("stub");
    expect(value.reasoning.toLowerCase()).toContain("no model was called");
  });
});
