// src/hooks/inbox.ts — durable buffer for hooks that arrive while relay is recovering (survives a crash mid-recovery; drained by recovery.ts).
import type { Database } from "bun:sqlite";
import { now } from "../core/clock.ts";

export function pushInbox(db: Database, body: unknown, headers: Record<string, string | undefined>) { db.run("insert into hook_inbox(received_at, headers_json, body_json) values(?,?,?)", [now(), JSON.stringify(headers), JSON.stringify(body)]); }
export function inboxSize(db: Database): number { return (db.query("select count(*) c from hook_inbox").get() as any).c; }
/** Pops the oldest entry (deleted only after the caller returns without throwing). */
export function drainInbox(db: Database, fn: (body: any, headers: Record<string, string | undefined>) => void): number {
  let n = 0;
  for (;;) {
    const row = db.query("select * from hook_inbox order by id limit 1").get() as any; if (!row) return n;
    fn(JSON.parse(row.body_json), JSON.parse(row.headers_json)); db.run("delete from hook_inbox where id=?", [row.id]); n++;
  }
}
