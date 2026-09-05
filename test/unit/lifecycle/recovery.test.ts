import { describe, expect, test } from "bun:test";
import { buildTestApp } from "../../helpers/app.ts";
import { recover } from "../../../src/lifecycle/recovery.ts";
import { loadTask } from "../../../src/core/events.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spool } from "../../../src/hooks/spool.ts";
import { setMeta, getMeta } from "../../../src/db/db.ts";
const args = (s: Awaited<ReturnType<typeof buildTestApp>>) => ({ db: s.db, log: s.log, runner: s.runner, permits: s.permits, outbox: s.outbox, dispatcher: s.dispatcher, scheduler: s.scheduler, tasks: s.svc, spool: { drain: async () => 0 }, maxAgents: () => 10, instanceId: () => "inst-test" });
describe("recover", () => {
  for (const transport of ["spool", "inbox", "stop-inbox", "end-inbox"] as const) test(`replays final completion before inferring a crash (${transport})`, async () => {
    const s = await buildTestApp(); const t = s.seedTask("running"); s.runner.rows.clear();
    s.permits.acquire({ holder_kind: "task", holder_id: `task:${t}`, task_uuid: t });
    const dir = mkdtempSync(join(tmpdir(), "relay-recovery-completion-"));
    const headers = { "x-relay-task": t, "x-relay-gen": "1" };
    const entries = [
      { hook_event_name: "SubagentStart", agent_id: "child-a", agent_type: "verify" },
      { hook_event_name: "SubagentStop", agent_id: "child-a", last_assistant_message: "Child verified" },
      { hook_event_name: "Stop", prompt_id: "final-turn", last_assistant_message: "RELAY: done\nAll artifacts verified.", background_tasks: [] },
      { hook_event_name: "SessionEnd", reason: "other" },
    ];
    try {
      entries.forEach((entry, i) => {
        const body = { ...entry, session_id: "sid1" }; const at = i + 1;
        const inbox = transport === "inbox" || (transport === "stop-inbox" && entry.hook_event_name !== "SessionEnd") || (transport === "end-inbox" && entry.hook_event_name === "SessionEnd");
        if (inbox) s.db.run("insert into hook_inbox(received_at,headers_json,body_json) values(?,?,?)", [at, JSON.stringify(headers), JSON.stringify(body)]);
        else writeFileSync(join(dir, `${10 - i}.json`), JSON.stringify({ received_at: at, headers, body })); // names deliberately reverse chronology
      });
      const report = await recover({ ...args(s), spool: new Spool(dir, () => s.svc.ingestDeps) });
      await s.settle();
      expect(report.crashed).toEqual([]);
      expect(loadTask(s.db, t)!.status).toBe("done"); expect(loadTask(s.db, t)!.process_state).toBe("stopped");
      expect(loadTask(s.db, t)!.last_summary).toBe("All artifacts verified.");
      const child = s.db.query("select status,process_state,last_summary from tasks where parent_uuid=?").get(t) as any;
      expect(child).toEqual({ status: "done", process_state: "stopped", last_summary: "Child verified" });
      expect(s.db.query("select count(*) n from permit_leases where released_at is null").get()).toEqual({ n: 0 });
      expect(s.runner.calls).toEqual([]); expect(report.invariants).toEqual([]);
      expect(report.inboxDrained).toBe(transport === "inbox" ? 4 : transport === "stop-inbox" ? 3 : transport === "end-inbox" ? 1 : 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("recovery barrier holds replay-triggered scheduling and cleanup until reconciliation completes", async () => {
    const s = await buildTestApp(); const t = s.seedTask("running"); const cleanup = s.seedTask("done");
    setMeta(s.db, "recovering", "1");
    s.outbox.enqueue(cleanup, "cleanup-stop", { kind: "stop", reason: "close" });
    s.outbox.enqueue(cleanup, "cleanup-rm", { kind: "rm" });
    s.scheduler.enqueue(t);
    await s.outbox.run(cleanup); await s.scheduler.pump();
    expect(s.runner.calls).toEqual([]); expect(loadTask(s.db, t)!.status).toBe("queued");
    // Recovery may replay hooks whose callbacks ask the executors to work. None may cross the barrier.
    const report = await recover({ ...args(s), spool: { drain: async () => {
      expect(getMeta(s.db, "recovering")).toBe("1");
      await s.outbox.run(cleanup); await s.scheduler.pump();
      expect(s.runner.calls).toEqual([]); return 0;
    } } });
    await s.settle();
    expect(getMeta(s.db, "recovering")).toBe("0");
    expect(s.runner.calls.map((c) => c.kind)).toEqual(["stop", "rm"]);
    expect(loadTask(s.db, cleanup)!.status).toBe("closed"); expect(report.invariants).toEqual([]);
  });

  test("a buffered SessionEnd is newer than the pre-replay alive roster", async () => {
    const s = await buildTestApp(); const t = s.seedTask("running");
    for (const [i, body] of [
      { hook_event_name: "Stop", prompt_id: "final", last_assistant_message: "RELAY: done\nComplete" },
      { hook_event_name: "SessionEnd", reason: "other" },
    ].entries()) s.db.run("insert into hook_inbox(received_at,headers_json,body_json) values(?,?,?)", [i, JSON.stringify({ "x-relay-task": t, "x-relay-gen": "1" }), JSON.stringify({ ...body, session_id: "sid1" })]);
    const report = await recover(args(s));
    expect(report.crashed).toEqual([]); expect(loadTask(s.db, t)!.status).toBe("done"); expect(loadTask(s.db, t)!.process_state).toBe("stopped");
  });

  test("replay keeps older-generation Stop and SessionEnd from changing the current worker", async () => {
    const s = await buildTestApp(); const t = s.seedTask("running", { process_generation: 2 });
    for (const [i, body] of [
      { hook_event_name: "Stop", prompt_id: "old-final", last_assistant_message: "RELAY: done\nOld result" },
      { hook_event_name: "SessionEnd", reason: "other" },
    ].entries()) s.db.run("insert into hook_inbox(received_at,headers_json,body_json) values(?,?,?)", [i, JSON.stringify({ "x-relay-task": t, "x-relay-gen": "1" }), JSON.stringify({ ...body, session_id: "sid1" })]);
    const report = await recover(args(s));
    expect(loadTask(s.db, t)!.status).toBe("running"); expect(loadTask(s.db, t)!.process_state).toBe("alive"); expect(loadTask(s.db, t)!.last_summary).toBeNull(); expect(report.invariants).toEqual([]);
  });
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
  test("a decision the crash interrupted is put back to `pending` and re-decided", async () => {
    // The `claude -p` that was deciding died with relay: nothing can ever finish or report it. While the row stays
    // `deciding`, drainPending re-enqueues it only for process() to return (the state is not `pending`) and
    // redispatch refuses it as still in flight — the user is left with no task, no answer and no way forward.
    const s = await buildTestApp();
    s.log.emit({ type: "message.received", payload: { id: "m1", role: "user", source: "user", client_message_id: "m1", dispatch_state: "pending", text: "auth 리팩토링 해줘", task_uuid: null, reply_to_task_uuid: null, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: 1 } });
    s.log.emit({ type: "dispatch.started", payload: { message_id: "m1", patch: { dispatch_state: "deciding" } } });
    const report = await recover(args(s));
    expect(report.redeciding).toEqual(["m1"]);
    await s.settle(60);
    expect((s.db.query("select dispatch_state from messages where id='m1'").get() as any).dispatch_state).toBe("dispatched");
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
