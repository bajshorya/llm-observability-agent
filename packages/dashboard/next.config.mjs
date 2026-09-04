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
 * @type {import("next").NextConfig}
 */
const config = {
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
