// src/core/replay.ts — rebuild every projection table from the event log (§3.2: the log is the source of truth; projections are a cache).
import type { Database } from "bun:sqlite";
import type { EventEnvelope } from "@shared/types.ts";
import type { Config } from "../config.ts";
import { applyProjection } from "./projections.ts";
const PROJECTIONS = ["tasks", "messages", "commands", "process_instances", "permit_leases", "ws_frames", "projects"];
const KEEP_META = ["schema_version", "relay_instance_id", "max_concurrent_agents", "delivery_method", "version", "log_dir", "oauth_fallback", "recovering"];   // operational keys are not event-sourced
/** Wipes projection tables and re-applies events in seq order inside one transaction. Returns the number of events replayed. */
export function rebuildProjections(db: Database, cfg: Config): number {
  let n = 0;
  db.transaction(() => {
    db.run("pragma defer_foreign_keys = on");
    for (const t of PROJECTIONS) db.run(`delete from ${t}`);
    db.run(`delete from meta where key not in (${KEEP_META.map(() => "?").join(",")}) and key not like 'usage_offset:%'`, KEEP_META);
    for (const r of db.query("select * from events order by seq").all() as any[]) {
      const ev: EventEnvelope = { ...r, v: r.v ?? 1, payload: JSON.parse(r.payload_json), truncated: !!r.truncated, blob_id: r.blob_id ?? null };
      const frames = applyProjection(db, ev, cfg).map((f, idx) => ({ ...f, seq: ev.seq, idx }));
      db.run("insert or replace into ws_frames(seq,frame_json) values(?,?)", [ev.seq, JSON.stringify(frames)]); n++;
    }
  })();
  return n;
}
