import { describe, expect, it } from "vitest";
import type { AnomalyTrigger } from "@obs/shared";
import {
  contextBudget,
  renderClassificationContext,
  sampleDiverse,
  sampleEvenly,
  type ClassificationInput,
  type ContextLogLine,
} from "./context";

const WINDOW_START = new Date("2026-08-10T08:23:00.000Z");
const WINDOW_END = new Date("2026-08-10T08:28:00.000Z");

const NEW_SIGNATURE_TRIGGER: AnomalyTrigger = {
  kind: "new_error_signature",
  service: "orders-api",
  signature: "TypeError: Cannot read properties of null (reading <str>)",
  sampleMessage: "TypeError: Cannot read properties of null (reading 'toFixed')",
  occurrences: 210,
};

function makeLines(count: number, level: ContextLogLine["level"] = "error"): ContextLogLine[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(WINDOW_START.getTime() + i * 1000),
    level,
    message: `failure number ${i}`,
    endpoint: "POST /orders",
    statusCode: 500,
  }));
}

function makeInput(overrides: Partial<ClassificationInput> = {}): ClassificationInput {
  const base: ClassificationInput = {
    service: "orders-api",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    triggers: [NEW_SIGNATURE_TRIGGER],
    metrics: { requestCount: 1200, errorCount: 211, p50Ms: 45, p95Ms: 82, p99Ms: 120 },
    signatures: [
      {
        signature: "TypeError: Cannot read properties of null (reading <str>)",
        occurrences: 210,
        sampleMessage: "TypeError: Cannot read properties of null (reading 'toFixed')",
      },
    ],
    logLines: makeLines(50),
    totalLogLines: 1200,
  };
  return { ...base, ...overrides };
}

describe("sampleEvenly", () => {
  it("returns everything when the input is under the limit", () => {
    expect(sampleEvenly([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  it("spans the whole input rather than taking a prefix", () => {
    const sampled = sampleEvenly(Array.from({ length: 100 }, (_, i) => i), 5);

    expect(sampled).toHaveLength(5);
    expect(sampled[0]).toBe(0);
    // A prefix slice would end at 4; an incident's later phase would be hidden.
    expect(sampled.at(-1)).toBeGreaterThan(50);
  });

  it("returns nothing for a zero limit", () => {
    expect(sampleEvenly([1, 2, 3], 0)).toEqual([]);
  });
});

describe("sampleDiverse", () => {
  const shape = (value: string): string => value;

  it("keeps a one-off line that uniform sampling would drown", () => {
    // The deploy-restart failure: one banner among two thousand routine lines.
    const lines = [...Array.from({ length: 2000 }, () => "GET /orders 200"), "v1.4.2 starting up"];

    expect(sampleDiverse(lines, 5, shape)).toContain("v1.4.2 starting up");
  });

  it("still fills the budget from common shapes", () => {
    const lines = [...Array.from({ length: 2000 }, () => "GET /orders 200"), "v1.4.2 starting up"];

    expect(sampleDiverse(lines, 5, shape)).toHaveLength(5);
  });

  it("shares the budget across shapes rather than by volume", () => {
    const lines = [
      ...Array.from({ length: 100 }, () => "common"),
      ...Array.from({ length: 10 }, () => "rare"),
    ];

    const sampled = sampleDiverse(lines, 6, shape);

    expect(sampled.filter((line) => line === "rare").length).toBeGreaterThanOrEqual(3);
  });

  it("returns everything when the input is under the limit", () => {
    expect(sampleDiverse(["a", "b"], 5, shape)).toEqual(["a", "b"]);
  });

  it("never exceeds the limit however many shapes there are", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `shape ${i}`);

    expect(sampleDiverse(lines, 6, shape)).toHaveLength(6);
  });
});

describe("renderClassificationContext", () => {
  it("emits the marker lines the stub provider parses", () => {
    const rendered = renderClassificationContext(makeInput());

    expect(rendered).toMatch(/^Service: orders-api$/m);
    expect(rendered).toMatch(/^Triggers fired: new_error_signature$/m);
  });

  it("explains each trigger in words, not just its name", () => {
    const rendered = renderClassificationContext(makeInput());

    expect(rendered).toContain("appears nowhere in the baseline hour");
    expect(rendered).toContain("210 times");
  });

  it("includes window totals with a computed error rate", () => {
    const rendered = renderClassificationContext(makeInput());

    expect(rendered).toContain("requests 1200 | errors 211 (17.6%)");
    expect(rendered).toContain("p95 82ms");
  });

  it("does not divide by zero on a window with no requests", () => {
    const rendered = renderClassificationContext(
      makeInput({ metrics: { requestCount: 0, errorCount: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 } }),
    );

    expect(rendered).toContain("errors 0 (0.0%)");
  });

  it("caps the log sample regardless of window size", () => {
    const rendered = renderClassificationContext({
      ...makeInput(),
      logLines: [...makeLines(5000), ...makeLines(500, "info")],
      totalLogLines: 5500,
    });

    const sampleLines = rendered
      .split("\n")
      .filter((line) => line.includes("POST /orders") && line.includes("—"));

    expect(sampleLines.length).toBeLessThanOrEqual(
      contextBudget.maxErrorLines + contextBudget.maxHealthyLines,
    );
    // The model is still told the true scale it was sampled from.
    expect(rendered).toContain("drawn from 5500");
  });

  it("keeps the one narration line that explains the window", () => {
    // A deploy banner among hundreds of routine requests. Losing this line
    // turns a benign restart into an indistinguishable outage.
    const routine = makeLines(500, "info").map((line) => ({
      ...line,
      message: "GET /orders 200",
    }));
    const banner: ContextLogLine = {
      timestamp: new Date(WINDOW_START.getTime() + 1000),
      level: "info",
      message: "orders-api v1.4.2 starting up (deploy 7c1e044)",
    };

    const rendered = renderClassificationContext({
      ...makeInput(),
      logLines: [...routine, banner],
    });

    expect(rendered).toContain("v1.4.2 starting up");
  });

  it("keeps a few healthy lines so degraded is distinguishable from down", () => {
    const rendered = renderClassificationContext({
      ...makeInput(),
      logLines: [...makeLines(100), ...makeLines(100, "info")],
    });

    expect(rendered).toContain("INFO");
    expect(rendered).toContain("ERROR");
  });

  it("lists the most frequent signatures first and says how many were cut", () => {
    const signatures = Array.from({ length: 20 }, (_, i) => ({
      signature: `signature ${i}`,
      occurrences: i,
      sampleMessage: `sample ${i}`,
    }));

    const rendered = renderClassificationContext(makeInput({ signatures }));

    expect(rendered).toContain(`top ${contextBudget.maxSignatures} of 20`);
    expect(rendered).toContain("signature 19");
    expect(rendered).not.toContain("signature 0\n");
  });

  it("truncates a stack trace instead of spending the budget on it", () => {
    const rendered = renderClassificationContext({
      ...makeInput(),
      logLines: [
        {
          timestamp: WINDOW_START,
          level: "error",
          message: "x".repeat(5000),
          endpoint: "POST /orders",
        },
      ],
    });

    expect(rendered).toContain("…");
    expect(rendered).not.toContain("x".repeat(contextBudget.maxMessageChars + 1));
  });

  it("omits the signature section entirely when there are none", () => {
    const rendered = renderClassificationContext(makeInput({ signatures: [] }));

    expect(rendered).not.toContain("Error signatures");
  });
});
