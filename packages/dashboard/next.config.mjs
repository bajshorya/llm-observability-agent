/**
 * Next.js configuration for the dashboard.
 *
 * WHY .mjs AND NOT .ts
 * Next transpiles a TypeScript config using the workspace's own `typescript`,
 * and this workspace is on TypeScript 7 — the native rewrite, whose API no
 * longer exposes the `ts.sys` surface Next's transpiler reaches for. The result
 * is a startup crash inside Next rather than anything to do with this file.
 * Plain ESM avoids the transpile step; the config is six lines and loses
 * nothing by not being typed.
 *
 * TWO SETTINGS, BOTH LOAD-BEARING
 *
 * `transpilePackages` — the workspace has no build step between packages. Every
 * other package is consumed as TypeScript directly, which is why an edit in
 * `shared` is visible everywhere immediately. Next does not do that for
 * workspace dependencies unless told to, so this preserves the convention
 * rather than introducing a compile step just for the dashboard.
 *
 * `serverExternalPackages` — `better-sqlite3` is a native module. Bundling it
 * breaks the binding at runtime with an error that points at Next rather than
 * at the cause, so it is left external and required at runtime.
 *
 * SECURITY HEADERS AND THE PASSWORD
 * Every response carries headers that stop the dashboard being framed
 * (clickjacking), sniffed, or leaking its URLs in a Referer. In production a
 * Content-Security-Policy confines scripts, styles and connections to this
 * origin; it is off in development, where Next's hot reload needs eval and a
 * websocket. 'unsafe-inline' remains for scripts and styles because Next
 * injects inline bootstrap scripts; removing it needs per-request nonces,
 * which would make every page dynamic for no gain on a page with no user
 * input to inject.
 *
 * The repo-root `.env` is loaded here so `DASHBOARD_PASSWORD` reaches the
 * proxy (src/proxy.ts) the same way every other variable reaches the backend.
 * A production server with no password says so at start-up.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), "../../.env"));
} catch {
  // No .env: defaults apply.
}

const production = process.env.NODE_ENV === "production";

if (production && !process.env.DASHBOARD_PASSWORD?.trim()) {
  console.warn(
    "DASHBOARD_PASSWORD is not set: anyone who can reach this port can read logs, diffs and suggested fixes.",
  );
}

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ...(production ? [{ key: "Content-Security-Policy", value: contentSecurityPolicy }] : []),
];

/** @type {import("next").NextConfig} */
const config = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  transpilePackages: ["@obs/backend", "@obs/shared"],
  serverExternalPackages: ["better-sqlite3"],
  /**
   * Next writes its own AGENTS.md and CLAUDE.md into the package on first run.
   * This repo already has a CLAUDE.md that governs the whole workspace, and a
   * second one describing only the dashboard is worse than none — it is the
   * file an agent reads first, and it would be the wrong file.
   */
  agentRules: false,
};

export default config;
