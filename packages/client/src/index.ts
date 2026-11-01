/**
 * `@obs/client` — the way a real service sends logs to this system.
 *
 *   createObsClient   batching, bounded, never-throwing log shipper
 *   obsMiddleware     one line per HTTP request, Express-style
 *   templatePath      `/orders/12778` → `/orders/:id`
 *
 * See `client.ts` for the delivery guarantees, and what it does not promise.
 */

export { createObsClient, levelForStatus } from "./client";
export type { ObsClient, ObsClientOptions, ObsClientStats, RequestLog } from "./client";
export { obsMiddleware } from "./middleware";
export { templatePath } from "./path";
