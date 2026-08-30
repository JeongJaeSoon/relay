import type { Database } from "bun:sqlite";
import type { EventEnvelope, WsFrame } from "@shared/types.ts";
import { parseConfig, type Config } from "../config.ts";   // REVIEW PATCH #2
import { now } from "./clock.ts";
import { ulid } from "./ids.ts";
import { capPayload } from "./redact.ts";
import { applyProjection } from "./projections.ts";
export { loadTask, loadMessage, loadProjects, rowToTask, systemState } from "./projections.ts";

export interface EmitInput {
  type: string; task_uuid?: string | null; source_session_id?: string | null; source_event_id?: string | null;
  process_generation?: number | null; turn_id?: string | null; tool_use_id?: string | null; causation_id?: string | null;
  occurred_at?: number; payload?: unknown;
}
export type Broadcast = (frames: WsFrame[]) => void;

/** The single write path: events append → projections → ws_frames, all in one transaction; broadcast after commit. */
export class EventLog {
  constructor(private db: Database, private broadcast: Broadcast = () => {}, public cfg: Config = parseConfig("")) {}
  emit(input: EmitInput): EventEnvelope | null {
    const out = this.emitMany([input]); return out[0] ?? null;
  }
  emitMany(inputs: EmitInput[]): (EventEnvelope | null)[] {
    const db = this.db; const pending: WsFrame[] = []; const results: (EventEnvelope | null)[] = [];
    const run = db.transaction(() => {
      for (const input of inputs) {
        const recorded_at = now(); const { json, truncated, blob } = capPayload(input.payload);
        const event_id = ulid();
        const dup = input.source_session_id != null && input.source_event_id != null   // `!= null`, not truthy: an empty id still hits the UNIQUE index, so it must go through dedupe
          ? db.query("select seq from events where source_session_id=? and process_generation is ? and source_event_id=?").get(input.source_session_id, input.process_generation ?? null, input.source_event_id) : null;
        if (dup) { results.push(null); continue; }
        const r = db.run(`insert into events(event_id,type,task_uuid,source_session_id,source_event_id,process_generation,turn_id,tool_use_id,causation_id,occurred_at,recorded_at,payload_json,truncated,blob_id,v) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
          [event_id, input.type, input.task_uuid ?? null, input.source_session_id ?? null, input.source_event_id ?? null, input.process_generation ?? null, input.turn_id ?? null, input.tool_use_id ?? null, input.causation_id ?? null, input.occurred_at ?? recorded_at, recorded_at, json, truncated ? 1 : 0, blob ? event_id : null]);
        if (blob) db.run("insert into blobs(id,created_at,body) values(?,?,?)", [event_id, recorded_at, Buffer.from(blob)]);
        const ev: EventEnvelope = { v: 1, seq: Number(r.lastInsertRowid), event_id, type: input.type, task_uuid: input.task_uuid ?? null, source_session_id: input.source_session_id ?? null, source_event_id: input.source_event_id ?? null,
          process_generation: input.process_generation ?? null, turn_id: input.turn_id ?? null, tool_use_id: input.tool_use_id ?? null, causation_id: input.causation_id ?? null, occurred_at: input.occurred_at ?? recorded_at, recorded_at, payload: JSON.parse(json), truncated, blob_id: blob ? event_id : null };
        const frames = applyProjection(db, ev, this.cfg).map((f, idx) => ({ ...f, seq: ev.seq, idx } as WsFrame));
        if (frames.length) db.run("insert or replace into ws_frames(seq,frame_json) values(?,?)", [ev.seq, JSON.stringify(frames)]);   // one row per frame-producing event, array of frames — an event with no frames (system.recovered) gets none, so max(seq) here is a cursor the client can actually reach
        pending.push(...frames); results.push(ev);
      }
    });
    run();
    if (pending.length) this.broadcast(pending);
    return results;
  }
  framesAfter(seq: number, limit = 5000): WsFrame[] {
    return this.db.query("select frame_json from ws_frames where seq>? order by seq limit ?").all(seq, limit).flatMap((r: any) => JSON.parse(r.frame_json) as WsFrame[]);
  }
  lastSeq(): number { return (this.db.query("select coalesce(max(seq),0) s from events").get() as any).s; }
  /** The catch-up target handed to clients. NOT lastSeq(): the dashboard cursor advances only with applied frames,
   *  and not every event produces one (system.recovered fires on every start and produces none), so an event cursor
   *  is a promise the client cannot keep — it would sit in `resync` forever. Every seq at or below this one has
   *  frames the client will apply. */
  lastFrameSeq(): number { return (this.db.query("select coalesce(max(seq),0) s from ws_frames").get() as any).s; }
}
