import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate, MIGRATIONS, SCHEMA_VERSION } from "../../../src/db/db.ts";

describe("db", () => {
  test("fresh db migrates to current version and is idempotent", () => {
    const db = openDb(":memory:");
    expect(migrate(db)).toEqual({ from: 0, to: SCHEMA_VERSION });
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    const tables = db.query("select name from sqlite_master where type='table' order by name").all().map((r: any) => r.name);
    for (const t of ["projects", "tasks", "messages", "events", "commands", "process_instances", "permit_leases", "ws_frames", "meta"]) expect(tables).toContain(t);
  });
  test("a file db is backed up before a real migration, not on first creation", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-db-")); const file = join(dir, "relay.db");
    const db = openDb(file); expect(migrate(db, dir)).toEqual({ from: 0, to: SCHEMA_VERSION }); db.close();
    expect(readdirSync(dir).filter((f) => f.startsWith("relay.db.bak-"))).toEqual([]);            // empty db: nothing worth backing up
    MIGRATIONS.push("create table extra(x integer);");                                             // simulate the next release's migration
    try {
      const db2 = openDb(file); expect(migrate(db2, dir)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION + 1 }); db2.close();
      expect(readdirSync(dir)).toContain(`relay.db.bak-${SCHEMA_VERSION}`);
    } finally { MIGRATIONS.pop(); }
  });
  test("events dedupe key is unique", () => {
    const db = openDb(":memory:"); migrate(db);
    const ins = () => db.run("insert into events(event_id,type,source_session_id,process_generation,source_event_id,occurred_at,recorded_at,payload_json) values (?,?,?,?,?,?,?,?)", [crypto.randomUUID(), "hook.Stop", "s1", 1, "stop:p1", 1, 1, "{}"]);
    ins(); expect(() => ins()).toThrow();
  });
});
