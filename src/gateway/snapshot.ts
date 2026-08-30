import type { Database } from "bun:sqlite";
import type { ForeignSession, TasksSnapshot } from "@shared/types.ts";
import type { Config } from "../config.ts";
import { loadProjects, rowToMessage, rowToTask, systemState } from "../core/projections.ts";
import { now } from "../core/clock.ts";
/** `foreign` is not read from the db: sessions relay does not own live in a poll projection, never in a table (foreign.ts). */
export function snapshot(db: Database, cfg: Config, includeClosed = false, foreign: ForeignSession[] = []): TasksSnapshot {
  const as_of_seq = (db.query("select coalesce(max(seq),0) s from ws_frames where frame_json<>'[]'").get() as any).s;   // the frame cursor, not the event cursor: a client only advances on frames it applies (EventLog.lastFrameSeq)
  const tasks = db.query(includeClosed ? "select * from tasks order by num" : "select * from tasks where status!='closed' or closed_at > ? order by num").all(...(includeClosed ? [] : [now() - 24 * 3600_000])).map(rowToTask);
  // rowid breaks created_at ties: several messages of one event share a millisecond, and the chat must not reorder them
  const messages = db.query("select * from messages where id in (select id from messages order by created_at desc, rowid desc limit 200) order by created_at, rowid").all().map(rowToMessage);
  return { as_of_seq, tasks, projects: loadProjects(db), state: systemState(db, cfg), messages, foreign };
}
