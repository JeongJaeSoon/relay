import { describe, expect, test } from "bun:test";
import { buildTestApp } from "../../helpers/app.ts";
import { recover } from "../../../src/lifecycle/recovery.ts";
import { loadTask } from "../../../src/core/events.ts";
const args = (s: Awaited<ReturnType<typeof buildTestApp>>) => ({ db: s.db, log: s.log, runner: s.runner, permits: s.permits, outbox: s.outbox, dispatcher: s.dispatcher, scheduler: s.scheduler, tasks: s.svc, spool: { drain: async () => 0 }, maxAgents: () => 10, instanceId: () => "inst-test" });
describe("recover", () => {
  test("reconciles alive/dead sessions, keeps attach leases, re-queues never-spawned tasks, releases stale leases, drains pending dispatch", async () => {
    const s = await buildTestApp(); const alive = s.seedTask("running"); const dead = s.seedTask("running"); const fresh = s.seedTask("starting", { session_id: null, short_id: null, process_state: "none", process_generation: 0 });
    s.db.run("update tasks set session_id='dead-sid', short_id='gone' where uuid=?", [dead]);
    // a spawn that was queued but never executed (relay died between the slot grant and the exec): insert the command without triggering the executor
    s.log.emit({ type: "command.queued", task_uuid: fresh, payload: { id: "spawn:fresh", kind: "spawn", payload: { kind: "spawn", spec: { taskUuid: fresh, displayId: "T-03", name: "relay:T-03 t", cwd: "/tmp/myapp", worktree: null, model: "m", effort: "xhigh", permissionMode: "auto", advisor: null, agent: "relay-worker", settingsJson: "{}", prompt: "p", env: {} } } } });
    for (const u of [alive, dead, fresh]) s.permits.acquire({ holder_kind: "task", holder_id: `task:${u}`, task_uuid: u });
    s.db.run("update tasks set attach_state='leased', attached_by='x' where uuid=?", [alive]);
    s.log.emit({ type: "message.received", payload: { id: "m1", role: "user", source: "user", client_message_id: "m1", dispatch_state: "pending", text: "상태?", task_uuid: null, reply_to_task_uuid: null, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: 1 } });
    const report = await recover(args(s));
    expect(report.crashed).toEqual([dead]); expect(loadTask(s.db, dead)!.status).toBe("error"); expect(loadTask(s.db, dead)!.process_state).toBe("crashed");
    expect(report.requeued).toEqual([fresh]); expect(["queued", "starting"]).toContain(loadTask(s.db, fresh)!.status);   // re-queued, and the scheduler may already have granted the slot again
    expect(loadTask(s.db, alive)!.attach_state).toBe("leased");                                                             // a user may still be attached
    await s.settle(); expect((s.db.query("select dispatch_state from messages where id='m1'").get() as any).dispatch_state).toBe("fastpath");
    expect((s.db.query("select value from meta where key='recovering'").get() as any)?.value).toBe("0");
    expect(report.invariants).toEqual([]);
  });
  test("when agents --json is unavailable nothing is touched and relay stays in recovering mode", async () => {
    const s = await buildTestApp(); const t = s.seedTask("running"); s.runner.list = async () => { throw new Error("daemon restarting"); };
    const report = await recover(args(s));
    expect(report.reconciled).toBe(0); expect(loadTask(s.db, t)!.status).toBe("running"); expect((s.db.query("select value from meta where key='recovering'").get() as any)?.value).toBe("1");
  });
  test("commands left `running` are reconciled (send → unknown) and a live session of a closed task is stopped and removed", async () => {
    const s = await buildTestApp(); const closed = s.seedTask("closed"); const t = s.seedTask("running");
    s.log.emit({ type: "command.queued", task_uuid: t, payload: { id: "send:x", kind: "send", payload: { kind: "send", text: "x", marker: "0000cccc" } } });
    s.log.emit({ type: "command.running", task_uuid: t, causation_id: "send:x", payload: { id: "send:x" } });
    const report = await recover(args(s));
    expect(report.commands).toEqual({ requeued: [], unknown: ["send:x"] }); expect(report.orphans).toEqual([closed]);
    await s.settle(); expect(s.runner.calls.map((c) => c.kind)).toEqual(["stop", "rm"]);
    expect((s.db.query("select state from commands where id='send:x'").get() as any).state).toBe("unknown"); expect(report.invariants).toEqual([]);
  });
});
