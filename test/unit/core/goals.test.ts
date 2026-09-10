import { describe, expect, test } from "bun:test";
import type { Task, TaskStatus, Message, WsFrame } from "../../../shared/types.ts";
import { openDb, migrate } from "../../../src/db/db.ts";
import { EventLog } from "../../../src/core/events.ts";
import { backfillLegacyGoals, goalCreatedInput, goalIdFor, goalNotificationDeliveredInput, goalReviewedInput, loadGoal, loadGoalCycles, loadGoalMembers, pendingGoalNotifications, reconcileGoal, reconcileGoalsForTask, reopenLatestCompletedGoalForTask, splitItemIdFor } from "../../../src/core/goals.ts";
import { rebuildProjections } from "../../../src/core/replay.ts";

const task = (uuid: string, num: number, status: TaskStatus = "running", process_state: Task["process_state"] = "none"): Task => ({
  uuid, num, display_id: `T-0${num}`, project_id: "p", title: uuid, status, size: "normal", effort: "xhigh", model: "m",
  session_id: process_state === "none" ? null : `session-${uuid}`, short_id: null, worktree_path: null, branch: null, base_sha: null, process_state, process_generation: process_state === "none" ? 0 : 3,
  turn_state: "idle", attach_state: "none", attached_by: null, paused: false, last_summary: null, last_step: null, question: null,
  parent_uuid: null, agent_id: null, agent_type: null, queued_at: null, qhead: false, started_at: null, ended_at: null,
  created_at: 1, updated_at: 1, closed_at: null, usage_tokens: 0, summary_json: null,
});
const message = (id = "m1"): Message => ({ id, role: "user", source: "github", client_message_id: `external-${id}`, dispatch_state: "dispatched", text: "original request, preserved exactly", task_uuid: null, reply_to_task_uuid: null, ask: false, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: 7 });

function setup(processState: Task["process_state"] = "none") {
  const db = openDb(":memory:"); migrate(db); const frames: WsFrame[] = []; const log = new EventLog(db, (xs) => frames.push(...xs));
  log.emit({ type: "project.registered", payload: { id: "p", name: "p", path: "/p", description: "", keywords: [], base_ref: "fresh", is_git: true, created_at: 1 } });
  log.emit({ type: "task.created", task_uuid: "u1", payload: task("u1", 1, "running", processState) });
  log.emit({ type: "task.created", task_uuid: "u2", payload: task("u2", 2, "running", processState) });
  const createGoal = (id = "m1") => log.emit(goalCreatedInput(message(id), [
    { split_item_id: splitItemIdFor(id, 0), task_uuid: "u1", task_display_id: "T-01" },
    { split_item_id: splitItemIdFor(id, 1), task_uuid: "u2", task_display_id: "T-02" },
  ]));
  const status = (uuid: string, value: TaskStatus) => log.emit({ type: "task.status_changed", task_uuid: uuid, payload: { status: value, patch: { status: value } } });
  return { db, log, frames, createGoal, status };
}

describe("durable goals", () => {
  test("snapshots the original request and immutable split membership in a retention-safe event", () => {
    const { db, log, createGoal } = setup(); const ev = createGoal()!; const id = goalIdFor("m1");
    expect(ev.task_uuid).toBeNull(); expect((ev.payload as any).task_uuids).toEqual(["u1", "u2"]);
    expect(loadGoal(db, id)).toMatchObject({ request_message_id: "m1", status: "active", current_generation: 1, original_request: { message_id: "m1", source: "github", client_message_id: "external-m1", text: "original request, preserved exactly", ask: false, created_at: 7 } });
    expect(loadGoalMembers(db, id).map((m) => [m.split_item_id, m.task_uuid, m.task_display_id, m.ordinal])).toEqual([["m1:0", "u1", "T-01", 0], ["m1:1", "u2", "T-02", 1]]);
    expect(() => log.emit(goalCreatedInput(message(), [{ split_item_id: "m1:0", task_uuid: "u2", task_display_id: "T-02" }]))).toThrow("redeclared differently");
    expect(loadGoalMembers(db, id).map((m) => m.task_uuid)).toEqual(["u1", "u2"]); expect(db.query("select count(*) c from events where type='goal.created'").get()).toEqual({ c: 1 });
  });

  test("blocks on error/needs_review, then completes once with the correct cancellation outcome", () => {
    const { db, log, createGoal, status } = setup(); createGoal(); const id = goalIdFor("m1");
    status("u1", "needs_review"); status("u2", "error"); expect(reconcileGoalsForTask(db, log, "u1")).toEqual([{ goal_id: id, action: "none", generation: 1 }]); expect(pendingGoalNotifications(db)).toHaveLength(0);
    status("u1", "done"); expect(reconcileGoal(db, log, id).action).toBe("none"); status("u2", "cancelled");
    expect(reconcileGoal(db, log, id)).toMatchObject({ action: "completed", generation: 1, outcome: "completed_with_cancellations" });
    expect(reconcileGoal(db, log, id).action).toBe("none");
    expect(loadGoal(db, id)).toMatchObject({ status: "completed", current_generation: 1, outcome: "completed_with_cancellations", review_due_at: expect.any(Number) });
    expect(loadGoal(db, id)!.review_due_at! - loadGoal(db, id)!.completed_at!).toBe(72 * 60 * 60 * 1000);
    expect(loadGoalCycles(db, id)[0]).toMatchObject({ status: "completed", outcome: "completed_with_cancellations", member_states: [{ task_uuid: "u1", status: "done" }, { task_uuid: "u2", status: "cancelled" }] });
    expect(pendingGoalNotifications(db)).toHaveLength(1); expect(db.query("select count(*) c from commands where kind in ('stop','rm')").get()).toEqual({ c: 0 });
    const complete = db.query("select payload_json from events where type='goal.completed'").get() as any; log.emit({ type: "goal.completed", payload: JSON.parse(complete.payload_json) });
    expect(db.query("select count(*) c from goal_notification_claims where goal_id=? and generation=1").get(id)).toEqual({ c: 1 });
  });

  test("a fresh route creates a new goal and never reopens historical completed goals", () => {
    const { db, log, createGoal, status } = setup(); createGoal("m1"); status("u1", "done"); status("u2", "done"); reconcileGoal(db, log, goalIdFor("m1"));
    status("u1", "queued"); expect(reconcileGoal(db, log, goalIdFor("m1"))).toEqual({ goal_id: goalIdFor("m1"), action: "none", generation: 1 });
    log.emit(goalCreatedInput(message("m2"), [{ split_item_id: splitItemIdFor("m2", 0), task_uuid: "u1", task_display_id: "T-01" }]));
    expect(loadGoal(db, goalIdFor("m1"))).toMatchObject({ status: "completed", current_generation: 1 }); expect(loadGoal(db, goalIdFor("m2"))).toMatchObject({ status: "active", current_generation: 1 });
  });

  test("an explicit cancelled-task retry reopens only its latest cancelled goal generation", () => {
    const { db, log, createGoal, status } = setup(); createGoal(); const id = goalIdFor("m1"); status("u1", "done"); status("u2", "cancelled"); reconcileGoal(db, log, id);
    expect(pendingGoalNotifications(db)).toHaveLength(1);
    const reopen = reopenLatestCompletedGoalForTask(db, "u2"); expect(reopen).not.toBeNull(); log.emit(reopen!); expect(loadGoal(db, id)).toMatchObject({ status: "active", current_generation: 2, outcome: null });
    expect(pendingGoalNotifications(db)).toEqual([]);
    expect(db.query("select state,delivered_at,resolved_at from goal_notification_claims where goal_id=? and generation=1").get(id)).toMatchObject({ state: "superseded", delivered_at: null, resolved_at: expect.any(Number) });
    status("u2", "closed"); expect(reconcileGoal(db, log, id)).toMatchObject({ action: "completed", generation: 2, outcome: "completed_with_cancellations" });
    expect(loadGoalCycles(db, id).map((c) => [c.generation, c.status, c.outcome])).toEqual([[1, "completed", "completed_with_cancellations"], [2, "completed", "completed_with_cancellations"]]);
    expect(pendingGoalNotifications(db).map((c) => c.generation)).toEqual([2]);
    expect(reopenLatestCompletedGoalForTask(db, "u1")).toBeNull();
  });

  test("completion claim and eligible generation-bound worker stops commit together", () => {
    const { db, log, createGoal, status } = setup("alive"); createGoal();
    log.emit(goalCreatedInput(message("m2"), [{ split_item_id: "m2:0", task_uuid: "u2", task_display_id: "T-02" }]));
    status("u1", "done"); status("u2", "done"); const result = reconcileGoal(db, log, goalIdFor("m1")); expect(result.stop_command_ids).toHaveLength(1);
    const rows = db.query("select task_uuid,kind,payload_json,state from commands order by task_uuid").all() as any[];
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ task_uuid: "u1", kind: "stop", state: "pending" });
    expect(JSON.parse(rows[0].payload_json)).toEqual({ kind: "stop", reason: "goal completed", expected: { goal_id: goalIdFor("m1"), generation: 1, process_generation: 3, session_id: "session-u1" } });
    expect(pendingGoalNotifications(db)).toHaveLength(1);
    const completionSeq = (db.query("select seq from events where type='goal.completed'").get() as any).seq; const stopSeq = (db.query("select seq from events where type='command.queued' and task_uuid='u1'").get() as any).seq;
    expect(stopSeq).toBe(completionSeq + 1); expect(db.query("select count(*) c from commands where kind='rm'").get()).toEqual({ c: 0 });
  });

  test("notification acknowledgement is event-sourced and idempotent", () => {
    const { db, log, frames, createGoal, status } = setup(); createGoal(); status("u1", "done"); status("u2", "done"); reconcileGoal(db, log, goalIdFor("m1")); const claim = pendingGoalNotifications(db)[0];
    expect(frames.filter((f) => f.type === "goal.updated").at(-1)).toMatchObject({ type: "goal.updated", goal: { id: goalIdFor("m1"), status: "completed" } });
    expect(frames.filter((f) => f.type === "goal.notification").at(-1)).toMatchObject({ type: "goal.notification", claim: { claim_id: claim.claim_id, state: "pending" } });
    log.emit(goalNotificationDeliveredInput(claim)); log.emit(goalNotificationDeliveredInput(claim)); expect(pendingGoalNotifications(db)).toEqual([]);
    expect(db.query("select state,delivered_at from goal_notification_claims where claim_id=?").get(claim.claim_id)).toMatchObject({ state: "delivered", delivered_at: expect.any(Number) });
    expect(frames.filter((f) => f.type === "goal.notification").at(-1)).toMatchObject({ type: "goal.notification", claim: { claim_id: claim.claim_id, state: "delivered" } });
  });

  test("completed goals stay visible until an idempotent explicit review event", () => {
    const { db, log, frames, createGoal, status } = setup(); createGoal(); status("u1", "done"); status("u2", "done"); reconcileGoal(db, log, goalIdFor("m1"));
    expect(loadGoal(db, goalIdFor("m1"))!.reviewed_at).toBeNull();
    log.emit(goalReviewedInput(db, goalIdFor("m1"))); const first = loadGoal(db, goalIdFor("m1"))!.reviewed_at;
    log.emit(goalReviewedInput(db, goalIdFor("m1")));
    expect(first).toEqual(expect.any(Number)); expect(loadGoal(db, goalIdFor("m1"))!.reviewed_at).toBe(first);
    expect(pendingGoalNotifications(db)).toEqual([]);
    expect(frames.filter((f) => f.type === "goal.updated").at(-1)).toMatchObject({ goal: { id: goalIdFor("m1"), reviewed_at: first } });
    expect(frames.filter((f) => f.type === "goal.notification").at(-1)).toMatchObject({ claim: { goal_id: goalIdFor("m1"), state: "reviewed", delivered_at: null, resolved_at: first } });
    expect(db.query("select task_uuid,payload_json from events where type='goal.reviewed'").all().every((r: any) => r.task_uuid === null && JSON.parse(r.payload_json).task_uuids.length === 2)).toBe(true);
  });

  test("goal projections and claims replay after every task-scoped event has been retained away", () => {
    const { db, log, createGoal, status } = setup(); createGoal(); status("u1", "done"); status("u2", "done"); reconcileGoal(db, log, goalIdFor("m1"));
    const tables = ["goals", "goal_members", "goal_cycles", "goal_notification_claims"]; const snap = () => tables.map((t) => JSON.stringify(db.query(`select * from ${t} order by 1`).all())); const before = snap();
    db.run("delete from ws_frames where seq in (select seq from events where task_uuid is not null)"); db.run("delete from events where task_uuid is not null"); expect(db.query("select count(*) c from events where type like 'goal.%' and task_uuid is null").get()).toEqual({ c: 2 });
    db.run("update goals set status='active',outcome=null"); db.run("delete from goal_notification_claims");
    log.cfg.idle.close_after_hours = 1; // replay uses the delay captured by goal.completed, not today's config
    rebuildProjections(db, log.cfg); expect(snap()).toEqual(before); expect(db.query("select count(*) c from tasks").get()).toEqual({ c: 0 });
  });

  test("rejects task-scoped goal events so retention cannot silently erase the aggregate", () => {
    const { db, log } = setup(); const input = goalCreatedInput(message(), [{ split_item_id: "m1:0", task_uuid: "u1", task_display_id: "T-01" }]);
    expect(() => log.emit({ ...input, task_uuid: "u1" })).toThrow("must not be task-scoped"); expect(db.query("select count(*) c from events where type='goal.created'").get()).toEqual({ c: 0 });
  });

  test("legacy dispatched split messages are backfilled as replayable goal events", () => {
    const { db, log } = setup(); const legacy = { ...message("legacy"), task_uuid: "u1", dispatch_json: { action: "split", confidence: "high", task_ids: ["T-01", "T-02"], items: [] } };
    log.emit({ type: "message.received", task_uuid: "u1", payload: legacy });
    expect(backfillLegacyGoals(db, log)).toBe(1); expect(backfillLegacyGoals(db, log)).toBe(0);
    expect(loadGoalMembers(db, goalIdFor("legacy")).map((m) => m.task_uuid)).toEqual(["u1", "u2"]);
    rebuildProjections(db, log.cfg); expect(loadGoal(db, goalIdFor("legacy"))?.original_request.text).toBe(legacy.text);
  });

  test("legacy cleanup decisions are never backfilled as work goals", () => {
    const { db, log } = setup(); const cleanup = { ...message("cleanup"), task_uuid: "u1", dispatch_json: { action: "close_task", confidence: "high", task_id: "T-01" } };
    log.emit({ type: "message.received", task_uuid: "u1", payload: cleanup });
    expect(backfillLegacyGoals(db, log)).toBe(0); expect(loadGoal(db, goalIdFor("cleanup"))).toBeNull();
  });

  test("legacy work whose task is already closed is skipped when its terminal result cannot be reconstructed", () => {
    const { db, log } = setup(); log.emit({ type: "task.status_changed", task_uuid: "u1", payload: { status: "closed", patch: { status: "closed", closed_at: 9 } } });
    const legacy = { ...message("closed-work"), task_uuid: "u1", dispatch_json: { action: "route_to_task", confidence: "high", task_id: "T-01" } };
    log.emit({ type: "message.received", task_uuid: "u1", payload: legacy });
    expect(backfillLegacyGoals(db, log)).toBe(0); expect(loadGoal(db, goalIdFor("closed-work"))).toBeNull();
  });
});
