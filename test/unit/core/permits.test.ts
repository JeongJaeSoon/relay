import { describe, expect, test } from "bun:test";
import { openDb, migrate } from "../../../src/db/db.ts";
import { EventLog } from "../../../src/core/events.ts";
import { parseConfig } from "../../../src/config.ts";
import { PermitPool } from "../../../src/core/permits.ts";

const mkTask = (db: any, log: EventLog, uuid: string, sess: string | null = null) => log.emit({ type: "task.created", task_uuid: uuid, payload: { uuid, num: Number(uuid.slice(1)), display_id: uuid, project_id: "p", title: uuid, status: "running", size: "normal", effort: "xhigh", model: "m", session_id: sess, short_id: null, worktree_path: null, branch: null, base_sha: null, process_state: "alive", process_generation: 1, turn_state: "busy", attach_state: "none", attached_by: null, paused: false, last_summary: null, last_step: null, question: null, parent_uuid: null, agent_id: null, agent_type: null, queued_at: null, qhead: false, started_at: 1, ended_at: null, created_at: 1, updated_at: 1, closed_at: null, usage_tokens: 0 } });

describe("PermitPool", () => {
  test("cap, release, reconcile order", () => {
    const db = openDb(":memory:"); migrate(db); const log = new EventLog(db, () => {}, parseConfig("")); db.run("insert into projects(id,name,path,created_at) values('p','p','/p',1)");
    let max = 2; const pool = new PermitPool(db, log, () => max);
    ["u1", "u2", "u3"].forEach((u, i) => mkTask(db, log, u, `s${i + 1}`));
    expect(pool.acquire({ holder_kind: "task", holder_id: "task:u1", task_uuid: "u1" })).toBe(true);
    expect(pool.acquire({ holder_kind: "subagent", holder_id: "agent:a", task_uuid: "u1" })).toBe(true);
    expect(pool.acquire({ holder_kind: "task", holder_id: "task:u2", task_uuid: "u2" })).toBe(false);
    max = 3; expect(pool.acquire({ holder_kind: "task", holder_id: "task:u2", task_uuid: "u2" })).toBe(true); expect(pool.active()).toBe(3);
    pool.release("agent:a"); expect(pool.active()).toBe(2);
    // reconcile: u1's session is dead → its lease is released first
    expect(pool.reconcile(new Set(["s2"]))).toEqual(["task:u1"]); expect(pool.active()).toBe(1);
  });
  test("subagent per-task cap (conservative mode)", () => {
    const db = openDb(":memory:"); migrate(db); const log = new EventLog(db, () => {}, parseConfig("")); db.run("insert into projects(id,name,path,created_at) values('p','p','/p',1)"); mkTask(db, log, "u1");
    const pool = new PermitPool(db, log, () => 10, { subagentPerTask: 1 });
    expect(pool.acquire({ holder_kind: "subagent", holder_id: "agent:a", task_uuid: "u1" })).toBe(true);
    expect(pool.acquire({ holder_kind: "subagent", holder_id: "agent:b", task_uuid: "u1" })).toBe(false);
  });
  test("rebind renames an active lease; firstUnbound only returns provisional sub: holders", () => {
    const db = openDb(":memory:"); migrate(db); const log = new EventLog(db, () => {}, parseConfig("")); db.run("insert into projects(id,name,path,created_at) values('p','p','/p',1)"); mkTask(db, log, "u1");
    const pool = new PermitPool(db, log, () => 10);
    pool.acquire({ holder_kind: "task", holder_id: "task:u1", task_uuid: "u1" });
    expect(pool.firstUnbound("u1")).toBeNull();
    pool.acquire({ holder_kind: "subagent", holder_id: "sub:u1:tu1", task_uuid: "u1" });
    expect(pool.firstUnbound("u1")).toBe("sub:u1:tu1");
    pool.rebind("sub:u1:tu1", "agent:ag1"); expect(pool.has("agent:ag1")).toBe(true); expect(pool.firstUnbound("u1")).toBeNull();
    pool.releaseTask("u1"); expect(pool.active()).toBe(0);
  });
});
