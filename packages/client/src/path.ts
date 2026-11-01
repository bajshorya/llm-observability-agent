/**
 * Route templating for request logs — pure.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 * The rollup worker aggregates per endpoint, per minute. If a service logs raw
 * paths, `/orders/12778` and `/orders/44012` are two endpoints, and a busy
 * service produces one "endpoint" per order id: per-endpoint rollups explode,
 * percentiles are computed over one request each, and the evidence packet's
 * per-endpoint breakdown is noise. It is the same failure signature
 * normalisation exists to prevent, one field over.
 *
 * So the client prefers the framework's route template (Express's
 * `req.route.path`, Fastify's `routeOptions.url`) and falls back to replacing
 * id-shaped segments here. The fallback is a heuristic and says so: a slug like
 * `/posts/hello-world` is kept as-is, because nothing distinguishes it from a
 * real path segment.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
/** Long hex runs: object ids, hashes, shas. Eight or more so `/v1` and `/cafe` survive. */
const HEX_ID = /^[0-9a-f]{8,}$/i;

function isIdSegment(segment: string): boolean {
  return NUMERIC.test(segment) || UUID.test(segment) || HEX_ID.test(segment);
}

/** `/orders/12778/items/9?x=1` → `/orders/:id/items/:id`. */
export function templatePath(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? "";
  const segments = withoutQuery.split("/").map((segment) => (isIdSegment(segment) ? ":id" : segment));
  const joined = segments.join("/");
  return joined === "" ? "/" : joined;
}
