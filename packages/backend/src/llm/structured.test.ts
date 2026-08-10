import { describe, expect, it } from "vitest";
import { classificationSchema } from "@obs/shared";
import { llmConfig } from "./config";
import { extractJsonObject, parseJsonObject } from "./json";
import { createStubProvider } from "./providers/stub";
import { generateStructured, LlmStructuredError, type LlmCallRecord } from "./structured";
import { LlmProviderError, type LlmCompletion, type LlmProvider, type LlmRequest } from "./types";

/**
 * These run against the **real** llmConfig, matching the detector tests: a
 * change to the repair ceiling should fail here rather than quietly alter how
 * much a failing model costs.
 */

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

  it("refuses agents it has no canned answer for", () => {
    expect(() =>
      createStubProvider().complete({
        system: "s",
        user: "u",
        agent: "correlator",
        temperature: 0,
        maxOutputTokens: 100,
      }),
    ).toThrow(LlmProviderError);
  });
});
