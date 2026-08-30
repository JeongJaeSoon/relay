import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, renameSync } from "node:fs";
import { join, basename } from "node:path";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.ts";
export { MIGRATIONS, SCHEMA_VERSION } from "./schema.ts";

export function openDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.run("pragma journal_mode = wal"); db.run("pragma foreign_keys = on"); db.run("pragma busy_timeout = 5000");
  return db;
}
const version = (db: Database): number => {
  const has = db.query("select 1 from sqlite_master where type='table' and name='meta'").get();
  if (!has) return 0;
  const row = db.query("select value from meta where key='schema_version'").get() as { value: string } | null;
  return row ? Number(row.value) : 0;
};
/** Apply pending migrations. For non-empty file DBs, copy `<db>.bak-<from>` first (atomic: copy to tmp then rename). Reads MIGRATIONS.length live so tests can append a migration. */
export function migrate(db: Database, backupDir?: string): { from: number; to: number } {
  const from = version(db); const target = MIGRATIONS.length;
  if (from >= target) return { from, to: from };
  const file = db.filename; let backupFile: string | null = null;
  if (from > 0 && file && file !== ":memory:" && existsSync(file)) {
    db.run("pragma wal_checkpoint(truncate)");
    const dir = backupDir ?? file.replace(/\/[^/]+$/, "");
    const bak = join(dir, `${basename(file)}.bak-${from}`);
    copyFileSync(file, bak + ".tmp"); renameSync(bak + ".tmp", bak); backupFile = bak;
  }
  const run = db.transaction(() => {
    for (let v = from; v < target; v++) {
      db.exec(MIGRATIONS[v]);
      db.run("insert into meta(key,value) values('schema_version',?) on conflict(key) do update set value=excluded.value", [String(v + 1)]);
    }
  });
  try { run(); }
  catch (e) {                                                              // the transaction rolled back; a file db additionally gets its pre-migration copy restored (§18)
    if (backupFile && existsSync(backupFile)) { db.close(); copyFileSync(backupFile, file + ".restore.tmp"); renameSync(file + ".restore.tmp", file); }
    throw new Error(`migration ${from}→${target} failed${backupFile ? ` (restored ${backupFile})` : ""}: ${String(e)}`);
  }
  return { from, to: target };
}
export const getMeta = (db: Database, key: string): string | null => ((db.query("select value from meta where key=?").get(key) as any)?.value ?? null);
export const setMeta = (db: Database, key: string, value: string) => db.run("insert into meta(key,value) values(?,?) on conflict(key) do update set value=excluded.value", [key, value]);
