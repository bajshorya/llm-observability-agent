/**
 * The client's promises, tested against a fake fetch: batching, bounded
 * memory, retry on the right statuses only, and never throwing into the host.
 */

import { describe, expect, it, vi } from "vitest";
import { createObsClient, levelForStatus } from "./client";
import { obsMiddleware } from "./middleware";
import { templatePath } from "./path";

type Call = {
  url: string;
  headers: Record<string, string>;
  body: { entries: Array<Record<string, unknown>> };
};

function fakeFetch(statuses: number[] = []) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Call["body"];
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body });
    const status = statuses.shift() ?? 202;
    if (status === -1) throw new TypeError("fetch failed");
    const accepted = status >= 200 && status < 300 ? body.entries.length : 0;
    return new Response(JSON.stringify({ accepted, rejected: 0, errors: [] }), { status });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const fixedNow = () => new Date("2026-11-01T12:00:00.000Z");

function client(fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createObsClient>[0]> = {}) {
  const errors: string[] = [];
  const obs = createObsClient({
    url: "http://ingest.test/ingest",
    service: "orders-api",
    fetch: fetchImpl,
    now: fixedNow,
    flushIntervalMs: 60_000,
    retryBaseMs: 1,
    onError: (e) => errors.push(e.message),
    ...extra,
  });
  return { obs, errors };
}

describe("createObsClient", () => {
  it("sends entries in the server's wire format", async () => {
    const { fn, calls } = fakeFetch();
    const { obs } = client(fn);
    obs.error("TypeError: x is null", { endpoint: "/orders/:id", statusCode: 500 });
    await obs.close();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.entries[0]).toEqual({
      timestamp: "2026-11-01T12:00:00.000Z",
      service: "orders-api",
      level: "error",
      message: "TypeError: x is null",
      metadata: { endpoint: "/orders/:id", statusCode: 500 },
    });
    expect(obs.stats()).toMatchObject({ sent: 1, dropped: 0, queued: 0 });
  });

  it("sends the ingest key as a bearer token, and nothing when it is empty", async () => {
    const keyed = fakeFetch();
    const { obs } = client(keyed.fn, { apiKey: "k3y" });
    obs.info("hello");
    await obs.close();
    expect(keyed.calls[0]?.headers["authorization"]).toBe("Bearer k3y");

    const open = fakeFetch();
    const { obs: obs2 } = client(open.fn, { apiKey: "" });
    obs2.info("hello");
    await obs2.close();
    expect(open.calls[0]?.headers).not.toHaveProperty("authorization");
  });

  it("reuses one idempotency key across a batch's retries, and a fresh one per batch", async () => {
    const { fn, calls } = fakeFetch([503, 503, 202, 202]);
    const { obs } = client(fn, { maxRetries: 2, batchSize: 1 });
    obs.info("first");
    await obs.flush();
    obs.info("second");
    await obs.close();
    const keys = calls.map((c) => c.headers["idempotency-key"]);
    expect(keys).toHaveLength(4);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(keys.slice(0, 3)).size).toBe(1);
    expect(keys[3]).not.toBe(keys[0]);
  });

  it("does not retry a refused key, and drops the batch", async () => {
    const { fn, calls } = fakeFetch([401]);
    const { obs, errors } = client(fn, { apiKey: "wrong" });
    obs.info("hello");
    await obs.close();
    expect(calls).toHaveLength(1);
    expect(obs.stats()).toMatchObject({ dropped: 1, sent: 0 });
    expect(errors[0]).toContain("HTTP 401");
  });

  it("splits into batches", async () => {
    const { fn, calls } = fakeFetch();
    const { obs } = client(fn, { batchSize: 10 });
    for (let i = 0; i < 25; i += 1) obs.info(`line ${i}`);
    await obs.flush();
    expect(calls.map((c) => c.body.entries.length)).toEqual([10, 10, 5]);
    expect(obs.stats().sent).toBe(25);
  });

  it("drops invalid entries at the call site, without throwing", async () => {
    const { fn, calls } = fakeFetch();
    const { obs, errors } = client(fn);
    expect(() => obs.info("")).not.toThrow();
    await obs.flush();
    expect(calls).toHaveLength(0);
    expect(obs.stats().dropped).toBe(1);
    expect(errors[0]).toContain("message");
  });

  it("bounds memory by dropping the OLDEST entries while a send is stuck", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sent: string[] = [];
    const slowFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      await gate;
      const body = JSON.parse(String(init?.body)) as Call["body"];
      sent.push(...body.entries.map((e) => String(e["message"])));
      return new Response(JSON.stringify({ accepted: body.entries.length, rejected: 0 }), { status: 202 });
    }) as unknown as typeof fetch;

    const { obs, errors } = client(slowFetch, { batchSize: 10, maxQueueSize: 10 });
    for (let i = 0; i < 10; i += 1) obs.info(`line ${i}`); // fills a batch; it goes in flight and hangs
    for (let i = 10; i < 35; i += 1) obs.info(`line ${i}`); // 25 more against a queue of 10

    expect(obs.stats()).toMatchObject({ queued: 10, dropped: 15 });
    expect(errors.some((e) => e.includes("queue full"))).toBe(true);

    release();
    await obs.flush();
    expect(sent.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, i) => `line ${i}`));
    // The survivors are the NEWEST lines; 10..24 were dropped.
    expect(sent.slice(10)).toEqual(Array.from({ length: 10 }, (_, i) => `line ${25 + i}`));
  });

  it("retries 5xx and network errors, then succeeds", async () => {
    const { fn, calls } = fakeFetch([503, -1, 202]);
    const { obs } = client(fn);
    obs.info("hello");
    await obs.flush();
    expect(calls).toHaveLength(3);
    expect(obs.stats()).toMatchObject({ sent: 1, dropped: 0 });
  });

  it("gives up after maxRetries and drops the batch rather than hold it", async () => {
    const { fn, calls } = fakeFetch([503, 503, 503, 503]);
    const { obs, errors } = client(fn, { maxRetries: 2 });
    obs.info("hello");
    await obs.flush();
    expect(calls).toHaveLength(3);
    expect(obs.stats()).toMatchObject({ sent: 0, dropped: 1, queued: 0 });
    expect(errors[0]).toContain("HTTP 503");
  });

  it("does not retry a 400 — the server already said no", async () => {
    const { fn, calls } = fakeFetch([400]);
    const { obs } = client(fn);
    obs.info("hello");
    await obs.flush();
    expect(calls).toHaveLength(1);
    expect(obs.stats()).toMatchObject({ rejected: 1, dropped: 0 });
  });

  it("drops logs after close instead of throwing", async () => {
    const { fn } = fakeFetch();
    const { obs } = client(fn);
    await obs.close();
    expect(() => obs.info("late")).not.toThrow();
    expect(obs.stats().dropped).toBe(1);
  });

  it("survives an onError that throws", async () => {
    const { fn } = fakeFetch();
    const { obs } = client(fn, {
      onError: () => {
        throw new Error("caller bug");
      },
    });
    expect(() => obs.info("")).not.toThrow();
  });

  it("logs a request with templated endpoint and status-derived level", async () => {
    const { fn, calls } = fakeFetch();
    const { obs } = client(fn);
    obs.request({ method: "get", endpoint: "/orders/12778?x=1", statusCode: 500, latencyMs: 41.6 });
    await obs.flush();
    expect(calls[0]?.body.entries[0]).toMatchObject({
      level: "error",
      message: "GET /orders/:id 500",
      metadata: { endpoint: "/orders/:id", method: "GET", statusCode: 500, latencyMs: 42 },
    });
  });
});

describe("levelForStatus", () => {
  it("maps 5xx to error, 4xx to warn, the rest to info", () => {
    expect(levelForStatus(503)).toBe("error");
    expect(levelForStatus(404)).toBe("warn");
    expect(levelForStatus(201)).toBe("info");
  });
});

describe("templatePath", () => {
  it("collapses id-shaped segments", () => {
    expect(templatePath("/orders/12778")).toBe("/orders/:id");
    expect(templatePath("/users/3f2b8c1e-1a2b-4c3d-9e8f-0123456789ab/cart")).toBe("/users/:id/cart");
    expect(templatePath("/commits/0c701a0bcc")).toBe("/commits/:id");
  });

  it("keeps ordinary segments, including short hex-looking words", () => {
    expect(templatePath("/v1/cafe/menu")).toBe("/v1/cafe/menu");
    expect(templatePath("/posts/hello-world")).toBe("/posts/hello-world");
    expect(templatePath("")).toBe("/");
  });
});

describe("obsMiddleware", () => {
  it("logs the route template when the framework provides one", async () => {
    const { fn, calls } = fakeFetch();
    const { obs } = client(fn);
    const listeners: Record<string, () => void> = {};
    const res = { statusCode: 404, once: (event: string, l: () => void) => (listeners[event] = l) };
    const next = vi.fn();

    obsMiddleware(obs)(
      { method: "GET", originalUrl: "/api/orders/9", baseUrl: "/api", route: { path: "/orders/:orderId" } },
      res,
      next,
    );
    expect(next).toHaveBeenCalled();
    listeners["finish"]?.();
    listeners["close"]?.(); // fires too on most servers; must not double-log
    await obs.flush();

    expect(calls[0]?.body.entries).toHaveLength(1);
    expect(calls[0]?.body.entries[0]).toMatchObject({
      level: "warn",
      message: "GET /api/orders/:orderId 404",
    });
  });
});
