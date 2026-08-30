import type { Database } from "bun:sqlite";
import type { TasksSnapshot } from "@shared/types.ts";
import type { Config } from "../config.ts";
import { loadProjects, rowToMessage, rowToTask, systemState } from "../core/projections.ts";
import { now } from "../core/clock.ts";
export function snapshot(db: Database, cfg: Config, includeClosed = false): TasksSnapshot {
  const as_of_seq = (db.query("select coalesce(max(seq),0) s from events").get() as any).s;
  const tasks = db.query(includeClosed ? "select * from tasks order by num" : "select * from tasks where status!='closed' or closed_at > ? order by num").all(...(includeClosed ? [] : [now() - 24 * 3600_000])).map(rowToTask);
  const messages = db.query("select * from (select * from messages order by created_at desc limit 200) order by created_at").all().map(rowToMessage);
  return { as_of_seq, tasks, projects: loadProjects(db), state: systemState(db, cfg), messages };
}
