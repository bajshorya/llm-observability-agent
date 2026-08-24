/**
 * Environment configuration, validated once at startup.
 *
 * WHAT THIS FILE DOES
 * Loads `.env`, validates every variable against a Zod schema, and exports the
 * parsed result as `env`. If anything is invalid the process exits immediately
 * with a per-field explanation, rather than failing mysteriously three layers
 * deep when something reads an undefined value.
 *
 * It also exports `REPO_ROOT`, resolved from this file's own location via
 * `import.meta.url` rather than from `process.cwd()`. That matters: it means the
 * database lands in the same place whether you run a command from the workspace
 * root or from inside a package.
 *
 * WHAT IT CONFIGURES
 *   PORT, DATABASE_URL           the ingestion API and its store
 *   LLM_PROVIDER, LLM_MODEL      which model the agents call, and an override
 *   GEMINI/NVIDIA/OPENROUTER key credentials, all optional
 *   OLLAMA_BASE_URL              local provider, no key needed
 *   TARGET_REPO_PATH             the repository Phase 3 correlates against
 *
 * TWO DETAILS THAT MATTER MORE THAN THEY LOOK
 *
 * `optionalSecret` treats an empty string as absent. An unset key in a `.env`
 * file arrives as `""`, not as undefined, so without this every commented-out
 * placeholder would read as a configured-but-blank credential. This is what
 * makes `.env.example` copyable as-is.
 *
 * `LLM_PROVIDER` defaults to `stub`. The whole pipeline — detect, classify,
 * persist, report — therefore runs end to end for someone who has just cloned
 * the repo and has no API key at all, and the test suite needs no network.
 * Spending money is opt-in, never the default.
 *
 * Uses Node's built-in `process.loadEnvFile`, so there is no dotenv dependency.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Repo root, resolved from this file rather than cwd, so the database lands
 *  in the same place whether you run from the workspace root or the package. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// Node's built-in .env loader — no dotenv dependency needed.
try {
  process.loadEnvFile(resolve(REPO_ROOT, ".env"));
} catch {
  // No .env file yet. Defaults below cover local development.
}

/**
 * An unset key in `.env` arrives as `""`, not as undefined. Treating the empty
 * string as "not provided" is what makes `.env.example` copyable as-is: the
 * commented-out placeholders stay empty until you actually have a key.
 */
const optionalSecret = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));

export const llmProviderNames = [
  "gemini",
  "nvidia",
  "openrouter",
  "ollama",
  "stub",
] as const;
export type LlmProviderName = (typeof llmProviderNames)[number];

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** `file:` prefix is optional and stripped by the db client. */
  DATABASE_URL: z.string().min(1).default("file:./data/dev.db"),

  /**
   * Which provider the agents call. Defaults to `stub` so the whole pipeline
   * runs — and the tests pass — with no API key and no network access.
   */
  LLM_PROVIDER: z.enum(llmProviderNames).default("stub"),
  /** Overrides the provider's default model. See src/llm/config.ts. */
  LLM_MODEL: optionalSecret,
  GEMINI_API_KEY: optionalSecret,
  NVIDIA_API_KEY: optionalSecret,
  OPENROUTER_API_KEY: optionalSecret,
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),

  /**
   * The repository Phase 3 correlates anomalies against. Relative paths
   * resolve from the repo root, not cwd, for the same reason DATABASE_URL
   * does.
   *
   * Defaults to the generated fixture, which is the repository the injected
   * bugs actually come from — `bash scripts/build-fixture-repo.sh` builds it.
   * Point this at a real checkout to correlate against real history.
   */
  TARGET_REPO_PATH: z.string().default("./fixtures/orders-api"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n"));
  process.exit(1);
}

export const env = parsed.data;
