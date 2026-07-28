import { defineConfig } from "drizzle-kit";

// Paths are relative to this package; the database lives at the repo root so
// a demo reset is a single `rm data/dev.db`.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "../../data/dev.db",
  },
});
