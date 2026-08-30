// src/lifecycle/retention.ts — 90-day retention: drop the event detail of long-closed tasks, VACUUM once a month.
import type { Database } from "bun:sqlite";
import { getMeta, setMeta } from "../db/db.ts";
import { now } from "../core/clock.ts";
import type { EventLog } from "../core/events.ts";
export function sweep(db: Database, days = 90, log?: EventLog) {
  const cutoff = now() - days * 86400_000; const tasks = (db.query("select uuid from tasks where status='closed' and closed_at<?").all(cutoff) as any[]).map((r) => r.uuid);
  let events = 0, blobs = 0;
  const tx = db.transaction(() => { for (const u of tasks) { const seqs = (db.query("select seq, event_id from events where task_uuid=?").all(u) as any[]); for (const s of seqs) { db.run("delete from ws_frames where seq=?", [s.seq]); blobs += db.run("delete from blobs where id=?", [s.event_id]).changes; } events += db.run("delete from events where task_uuid=?", [u]).changes; } });
  tx();
  const last = Number(getMeta(db, "last_vacuum") ?? 0); let vacuumed = false; if (now() - last > 30 * 86400_000) { db.run("vacuum"); setMeta(db, "last_vacuum", String(now())); vacuumed = true; }   // vacuum cannot run inside the transaction
  if (log && (events || blobs)) log.emit({ type: "retention.swept", payload: { events, blobs } });
  return { events, blobs, vacuumed };
}
