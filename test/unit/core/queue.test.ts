import { describe, expect, test } from "bun:test";
import { openDb, migrate } from "../../../src/db/db.ts";
import { EventLog, loadTask } from "../../../src/core/events.ts";
import { parseConfig } from "../../../src/config.ts";
import { PermitPool } from "../../../src/core/permits.ts";
import { Scheduler } from "../../../src/core/queue.ts";

const mk = (log: EventLog, uuid: string, project = "p", at = 1) => log.emit({ type: "task.created", task_uuid: uuid, payload: { uuid, num: Number(uuid.slice(1)), display_id: uuid, project_id: project, title: uuid, status: "queued", size: "normal", effort: "xhigh", model: "m", session_id: null, short_id: null, worktree_path: null, branch: null, base_sha: null, process_state: "none", process_generation: 0, turn_state: "idle", attach_state: "none", attached_by: null, paused: false, last_summary: null, last_step: null, question: null, parent_uuid: null, agent_id: null, agent_type: null, queued_at: at, qhead: false, started_at: null, ended_at: null, created_at: at, updated_at: at, closed_at: null, usage_tokens: 0 } });

describe("Scheduler", () => {
  test("FIFO with qhead first, honours cap, skips non-git project with a running task, pauses on kill switch", async () => {
    const db = openDb(":memory:"); migrate(db); const log = new EventLog(db, () => {}, parseConfig(""));
    db.run("insert into projects(id,name,path,is_git,created_at) values('p','p','/p',1,1),('ng','ng','/ng',0,1)");
    const pool = new PermitPool(db, log, () => 2); const started: string[] = []; let paused = false;
    const sch = new Scheduler(db, log, pool, async (t) => { started.push(t.uuid); }, () => paused);
    mk(log, "u1", "p", 1); mk(log, "u2", "p", 2); mk(log, "u3", "p", 3); sch.enqueue("u3", true);
    await sch.pump(); expect(started).toEqual(["u3", "u1"]); expect(loadTask(db, "u2")!.status).toBe("queued"); expect(loadTask(db, "u1")!.status).toBe("starting");
    pool.release("task:u3"); log.emit({ type: "task.status_changed", task_uuid: "u3", payload: { status: "done", patch: { status: "done" } } });
    mk(log, "u4", "ng", 4); mk(log, "u5", "ng", 5);
    await sch.pump(); expect(started).toEqual(["u3", "u1", "u2"]);            // u2 next (cap 2)
    pool.release("task:u1"); log.emit({ type: "task.status_changed", task_uuid: "u1", payload: { status: "done", patch: { status: "done" } } });
    await sch.pump(); expect(started.at(-1)).toBe("u4");
    pool.release("task:u2"); log.emit({ type: "task.status_changed", task_uuid: "u2", payload: { status: "done", patch: { status: "done" } } });
    await sch.pump(); expect(started).not.toContain("u5");                     // ng project already has u4 starting
    paused = true; pool.release("task:u4"); log.emit({ type: "task.status_changed", task_uuid: "u4", payload: { status: "done", patch: { status: "done" } } });
    await sch.pump(); expect(started).not.toContain("u5");                     // kill switch
  });
  test("returns the slot when onSlot leaves the task unable to run, and does not re-queue it", async () => {
    const db = openDb(":memory:"); migrate(db); const log = new EventLog(db, () => {}, parseConfig(""));
    db.run("insert into projects(id,name,path,is_git,created_at) values('p','p','/p',1,1)");
    const pool = new PermitPool(db, log, () => 2); mk(log, "u1", "p", 1);
    // what a spawn whose outcome relay could not read does: the outbox parks the task in `error` and returns normally
    const sch = new Scheduler(db, log, pool, async (t) => { log.emit({ type: "task.status_changed", task_uuid: t.uuid, payload: { status: "error", patch: { status: "error", ended_at: 2 } } }); }, () => false);
    await sch.pump();
    expect(pool.active()).toBe(0);                                                // the slot must not leak
    expect(loadTask(db, "u1")!.status).toBe("error");                             // and the task is not resurrected behind the operator's back
  });
  test("a failing onSlot returns the slot and re-queues the task at the head", async () => {
    const db = openDb(":memory:"); migrate(db); const log = new EventLog(db, () => {}, parseConfig(""));
    db.run("insert into projects(id,name,path,is_git,created_at) values('p','p','/p',1,1)");
    const pool = new PermitPool(db, log, () => 2); mk(log, "u1", "p", 1);
    const sch = new Scheduler(db, log, pool, async () => { throw new Error("boom"); }, () => false);
    await sch.pump();
    expect(pool.active()).toBe(0); expect(loadTask(db, "u1")!.status).toBe("queued"); expect(loadTask(db, "u1")!.qhead).toBe(true);
  });
});
