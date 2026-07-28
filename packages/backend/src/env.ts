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

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** `file:` prefix is optional and stripped by the db client. */
  DATABASE_URL: z.string().min(1).default("file:./data/dev.db"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n"));
  process.exit(1);
}

export const env = parsed.data;
