/**
 * Request logging for Express-style servers, with no dependency on Express.
 *
 *     app.use(obsMiddleware(obs));
 *
 * Logs one line per request when the response finishes: method, route
 * template, status and latency — the four fields the rollups and all three
 * request-shaped detectors are built from. The route template is taken from
 * `req.route.path` (Express sets it once a route has matched) with
 * `req.baseUrl` for mounted routers; failing that, the raw path is templated
 * by `templatePath`. See `path.ts` for why the template matters.
 *
 * The types are structural — the handful of fields read, nothing more — so the
 * package does not depend on Express, and works with anything shaped like it
 * (Connect, plain `node:http` with a `next`-less wrapper).
 */

import type { ObsClient } from "./client";

interface RequestLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  baseUrl?: string;
  path?: string;
  route?: { path?: unknown };
  headers?: Record<string, string | string[] | undefined>;
}

interface ResponseLike {
  statusCode: number;
  once(event: "finish" | "close", listener: () => void): unknown;
}

export function obsMiddleware(client: ObsClient) {
  return (req: RequestLike, res: ResponseLike, next: () => void): void => {
    const started = performance.now();
    let logged = false;

    const done = () => {
      if (logged) return;
      logged = true;

      const routePath = typeof req.route?.path === "string" ? req.route.path : null;
      const endpoint = routePath
        ? `${req.baseUrl ?? ""}${routePath}`
        : (req.originalUrl ?? req.url ?? req.path ?? "/");
      const requestId = req.headers?.["x-request-id"];

      client.request({
        method: req.method ?? "GET",
        endpoint,
        statusCode: res.statusCode,
        latencyMs: performance.now() - started,
        ...(typeof requestId === "string" ? { requestId } : {}),
      });
    };

    // `close` covers a client that disconnects before `finish`.
    res.once("finish", done);
    res.once("close", done);
    next();
  };
}
