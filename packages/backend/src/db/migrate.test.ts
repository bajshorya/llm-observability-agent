/**
 * Migrations against in-memory databases. No file, no fixture: the point is
 * that a database built from `migrations` alone matches `schema.ts`, which is
 * what catches a column added to the schema without a migration.
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { LATEST_VERSION, migrate, missingColumns, migrations, type Migration } from "./migrate";
import * as schema from "./schema";

const TABLES = [
  schema.logs,
  schema.metricsRollup,
  schema.anomalies,
  schema.correlations,
  schema.hypotheses,
  schema.llmCalls,
  schema.alerts,
];

const version = (db: Database.Database) => db.pragma("user_version", { simple: true });

describe("migrate", () => {
  it("builds an empty database into exactly what schema.ts declares", () => {
    const db = new Database(":memory:");
    const result = migrate(db);
    expect(result.from).toBe(0);
    expect(result.to).toBe(LATEST_VERSION);
    expect(missingColumns(db, TABLES)).toEqual([]);
  });

  it("is a no-op the second time", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(migrate(db).applied).toEqual([]);
    expect(version(db)).toBe(LATEST_VERSION);
  });

  it("adopts a database made by db:push (tables present, user_version 0) without error", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.prepare("INSERT INTO anomalies (id, detected_at, window_start, window_end, service, triggers, created_at) VALUES ('a', 1, 1, 2, 's', '[]', 1)").run();
    db.pragma("user_version = 0");

    expect(() => migrate(db)).not.toThrow();
    expect(version(db)).toBe(LATEST_VERSION);
    expect(db.prepare("SELECT count(*) AS n FROM anomalies").get()).toEqual({ n: 1 });
  });

  it("adds a column an older pushed database lacks", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE hypotheses (
      id text PRIMARY KEY NOT NULL, anomaly_id text NOT NULL, root_cause text NOT NULL,
      suggested_fix text NOT NULL, confidence real NOT NULL,
      applied integer DEFAULT false NOT NULL, created_at integer NOT NULL)`);
    migrate(db);
    expect(missingColumns(db, [schema.hypotheses])).toEqual([]);
  });

  it("reports columns that are missing, by table", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE alerts (id text PRIMARY KEY)");
    expect(missingColumns(db, [schema.alerts])).toContain("alerts.anomaly_id");
  });

  it("rolls back every pending migration if one fails", () => {
    const db = new Database(":memory:");
    const broken: Migration[] = [
      ...migrations,
      { version: LATEST_VERSION + 1, name: "ok", up: (d) => d.exec("CREATE TABLE extra (x integer)") },
      { version: LATEST_VERSION + 2, name: "boom", up: (d) => d.exec("NOT SQL") },
    ];
    expect(() => migrate(db, broken)).toThrow();
    expect(version(db)).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'extra'").get()).toBeUndefined();
  });

  it("keeps versions strictly increasing", () => {
    const versions = migrations.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });
});
