import { beforeEach, describe, expect, test } from "bun:test";
import { openDb, migrate } from "../../../src/db/db.ts";
import { EventLog, loadTask } from "../../../src/core/events.ts";
import type { Task, WsFrame } from "../../../shared/types.ts";
import type { Database } from "bun:sqlite";

const baseTask = (uuid: string): Task => ({ uuid, num: 1, display_id: "T-01", project_id: "p1", title: "t", status: "queued", size: "normal", effort: "xhigh", model: "claude-opus-5",
  session_id: null, short_id: null, worktree_path: null, branch: null, base_sha: null, process_state: "none", process_generation: 0, turn_state: "idle", attach_state: "none", attached_by: null,
  paused: false, last_summary: null, last_step: null, question: null, parent_uuid: null, agent_id: null, agent_type: null, queued_at: 1, qhead: false, started_at: null, ended_at: null, summary_json: null,
  created_at: 1, updated_at: 1, closed_at: null, usage_tokens: 0 });

describe("EventLog.emit", () => {
  let db: Database; let frames: WsFrame[]; let log: EventLog;
  beforeEach(() => { db = openDb(":memory:"); migrate(db); db.run("insert into projects(id,name,path,created_at) values('p1','p','/tmp/p',1)"); frames = []; log = new EventLog(db, (f) => frames.push(...f)); });

  test("append + projection + frame in one transaction, seq monotonic", () => {
    const e1 = log.emit({ type: "task.created", task_uuid: "u1", payload: baseTask("u1") })!;
    const e2 = log.emit({ type: "task.status_changed", task_uuid: "u1", payload: { status: "running", patch: { status: "running", started_at: 5 } } })!;
    expect(e2.seq).toBe(e1.seq + 1);
    expect(loadTask(db, "u1")!.status).toBe("running");
    const nf = frames.filter((f) => f.type !== "system.state"); /* REVIEW PATCH #5: impl also emits system.state */
    expect(nf.map((f) => f.type)).toEqual(["task.created", "task.updated"]);
    expect(nf[1].seq).toBe(e2.seq);
    expect(db.query("select count(*) c from ws_frames").get()).toEqual({ c: 2 });
  });
  test("duplicate hook (same session, generation, source id) is dropped and returns null", () => {
    log.emit({ type: "task.created", task_uuid: "u1", payload: baseTask("u1") });
    const a = log.emit({ type: "hook.Stop", task_uuid: "u1", source_session_id: "s", process_generation: 1, source_event_id: "stop:p1", payload: {} });
    const b = log.emit({ type: "hook.Stop", task_uuid: "u1", source_session_id: "s", process_generation: 1, source_event_id: "stop:p1", payload: {} });
    expect(a).not.toBeNull(); expect(b).toBeNull();
    expect(db.query("select count(*) c from events").get()).toEqual({ c: 2 });
  });
  test("projection failure rolls back the append", () => {
    expect(() => log.emit({ type: "task.status_changed", task_uuid: "missing", payload: { status: "running", patch: {} } })).toThrow();
    expect(db.query("select count(*) c from events").get()).toEqual({ c: 0 });
  });
  test("broadcast happens after commit", () => {
    let seenDuringTx = -1;
    const l2 = new EventLog(db, () => { seenDuringTx = (db.query("select count(*) c from events").get() as any).c; });
    l2.emit({ type: "task.created", task_uuid: "u9", payload: baseTask("u9") });
    expect(seenDuringTx).toBe(1);
  });
});
