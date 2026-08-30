import { describe, expect, test } from "bun:test";
import { openDb, migrate } from "../../../src/db/db.ts";
import { EventLog, loadTask } from "../../../src/core/events.ts";
import { parseConfig } from "../../../src/config.ts";
import { PermitPool } from "../../../src/core/permits.ts";
import { Scheduler } from "../../../src/core/queue.ts";
import { Outbox } from "../../../src/lifecycle/outbox.ts";
import { FakeRunner } from "../../../src/runner/fake.ts";
import { TaskService } from "../../../src/core/tasks.ts";
import { ulid } from "../../../src/core/ids.ts";
import { ingestHook } from "../../../src/hooks/ingest.ts";
import stopDone from "../../fixtures/stop-done.json"; import stopQuestion from "../../fixtures/stop-question.json";

function setup(max = 2) {
  const cfg = parseConfig(`max_concurrent_agents = ${max}`); const db = openDb(":memory:"); migrate(db); const log = new EventLog(db, () => {}, cfg);
  db.run("insert into projects(id,name,path,is_git,created_at) values('p1','myapp','/tmp/myapp',1,1)");
  const permits = new PermitPool(db, log, () => max); const runner = new FakeRunner(); let svc!: TaskService;
  const outbox = new Outbox(db, log, runner, { delivery: () => "resume", isPaused: () => svc.paused(), settingsJson: () => "{}", env: () => ({}), socketPathFor: (r) => `/tmp/${r.pid}.sock`, instanceId: () => "inst" });
  const scheduler = new Scheduler(db, log, permits, (t) => svc.startSlot(t), () => svc.paused());
  svc = new TaskService({ db, log, cfg, permits, scheduler, outbox, projectNameOf: () => "myapp", pendingPermissions: new Map() });
  const userMsg = (text: string, reply: string | null = null) => { const id = ulid(); log.emit({ type: "message.received", payload: { id, role: "user", source: "user", client_message_id: id, dispatch_state: "pending", text, task_uuid: null, reply_to_task_uuid: reply, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: 1 } }); return { id, role: "user", source: "user", client_message_id: id, dispatch_state: "pending", text, task_uuid: null, reply_to_task_uuid: reply, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: 1 } as any; };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const hook = (task: string, body: Record<string, unknown>) => { const t = loadTask(db, task)!; const row = [...runner.rows.values()].find((r) => r.short_id === t.short_id)!; return ingestHook({ ...body, session_id: row.session_id, transcript_path: "/t", cwd: row.cwd }, { "x-relay-task": task }, svc.ingestDeps); };   // the fixture's own session_id must not override
  /** The last session relay STARTED. Reaping a superseded session issues stop/rm after a resume, so the raw last call is no longer the resume. */
  const lastStart = () => [...runner.calls].reverse().find((c) => c.kind === "spawn" || c.kind === "resume")?.kind;
  return { db, log, cfg, permits, runner, outbox, scheduler, svc, userMsg, settle, hook, lastStart };
}
describe("TaskService", () => {
  test("new_task → queued → slot → spawn → SessionStart makes it running; Stop(done) promotes summary and frees the permit", async () => {
    const s = setup(); s.svc.applyDecision(s.userMsg("auth 리팩토링 해줘"), { action: "new_task", project: "myapp", title: "auth 리팩토링", size: "normal", prompt: "auth 리팩토링 해줘", confidence: "high" }); await s.settle();
    const t = s.db.query("select * from tasks").get() as any; expect(t.status).toBe("starting"); expect(s.runner.calls[0].kind).toBe("spawn");
    const spec: any = s.runner.calls[0].args; expect(spec.worktree).toMatch(/^relay-[0-9a-f]{8}$/); expect(spec.effort).toBe("xhigh"); expect(spec.advisor).toBeNull(); expect(spec.prompt).toMatch(/^\[relay #[0-9a-f]{8}\] T-01 · project=myapp · size=normal\n\nauth 리팩토링 해줘$/);
    s.hook(t.uuid, { hook_event_name: "SessionStart", source: "startup" }); expect(loadTask(s.db, t.uuid)!.status).toBe("running");
    s.hook(t.uuid, { ...(stopDone as any) });
    const done = loadTask(s.db, t.uuid)!; expect(done.status).toBe("done"); expect(done.last_summary).toMatch(/\S/); expect(s.permits.active()).toBe(0);
    expect(s.db.query("select role from messages order by rowid").all().map((r: any) => r.role)).toEqual(["user", "system", "system", "worker_summary"]);   // user, dispatcher badge, started, summary
  });
  test("epic keeps the advisor decision; small gets high effort", async () => {
    const s = setup(); s.svc.applyDecision(s.userMsg("big"), { action: "new_task", project: "myapp", title: "big", size: "epic", prompt: "big", confidence: "high" }); s.svc.applyDecision(s.userMsg("typo"), { action: "new_task", project: "myapp", title: "typo", size: "small", prompt: "typo", confidence: "high" }); await s.settle();
    const specs = s.runner.calls.map((c: any) => c.args); expect(specs[0].advisor).toBe("claude-fable-5"); expect(specs[1].effort).toBe("high");
  });
  test("route_to_task on a running task enqueues a send; on a done task re-queues at head then resumes", async () => {
    const s = setup(); s.svc.applyDecision(s.userMsg("a"), { action: "new_task", project: "myapp", title: "a", size: "normal", prompt: "a", confidence: "high" }); await s.settle();
    const t = s.db.query("select uuid from tasks").get() as any; s.hook(t.uuid, { hook_event_name: "SessionStart", source: "startup" });
    s.svc.applyDecision(s.userMsg("테스트도"), { action: "route_to_task", task_id: "T-01", prompt: "테스트도 추가해", confidence: "high" }); await s.settle();
    expect(s.runner.calls.map((c) => c.kind)).toEqual(["spawn", "stop", "resume", "stop"]);   // the trailing stop reaps the superseded session; removing it waits for close, since the fork shares its worktree
    s.hook(t.uuid, { hook_event_name: "SessionStart", source: "resume" }); s.hook(t.uuid, { ...(stopDone as any) }); expect(loadTask(s.db, t.uuid)!.status).toBe("done");
    s.svc.applyDecision(s.userMsg("하나 더"), { action: "route_to_task", task_id: "T-01", prompt: "하나 더", confidence: "high" }); await s.settle();
    expect(loadTask(s.db, t.uuid)!.status).toBe("starting"); expect(s.lastStart()).toBe("resume"); expect(s.permits.active()).toBe(1);
  });
  test("question → waiting_input frees permit; answer re-acquires and sends", async () => {
    const s = setup(1); s.svc.applyDecision(s.userMsg("a"), { action: "new_task", project: "myapp", title: "a", size: "normal", prompt: "a", confidence: "high" }); s.svc.applyDecision(s.userMsg("b"), { action: "new_task", project: "myapp", title: "b", size: "normal", prompt: "b", confidence: "high" }); await s.settle();
    const [ta, tb] = s.db.query("select uuid from tasks order by num").all() as any[]; expect(loadTask(s.db, tb.uuid)!.status).toBe("queued");
    expect(s.runner.calls.filter((c) => c.kind === "spawn").length).toBe(1);                               // cap 1: b is not spawned while a holds the slot
    s.hook(ta.uuid, { hook_event_name: "SessionStart", source: "startup" }); s.hook(ta.uuid, { ...(stopQuestion as any) }); await s.settle();
    expect(loadTask(s.db, ta.uuid)!.status).toBe("waiting_input"); expect(loadTask(s.db, ta.uuid)!.question!.options.length).toBe(2);
    expect(loadTask(s.db, tb.uuid)!.status).toBe("starting");                          // permit went to b
    s.svc.answer(ta.uuid, "a.txt", null); await s.settle();
    expect(loadTask(s.db, ta.uuid)!.status).toBe("queued"); expect(loadTask(s.db, ta.uuid)!.qhead).toBe(true); expect(loadTask(s.db, ta.uuid)!.question).toBeNull();
    expect(s.db.query("select count(*) c from commands where kind='send' and state='pending'").get()).toEqual({ c: 1 });
    expect(s.runner.calls.filter((c) => c.kind === "spawn").length).toBe(2);                               // b took the slot a released
  });
  test("answer(): a permission question resolves the held hook and the task keeps running; a follow-up to a running task is a plain send", async () => {
    const s = setup(); s.svc.applyDecision(s.userMsg("a"), { action: "new_task", project: "myapp", title: "a", size: "normal", prompt: "a", confidence: "high" }); await s.settle();
    const t = (s.db.query("select uuid from tasks").get() as any).uuid; s.hook(t, { hook_event_name: "SessionStart", source: "startup" });
    const r = s.hook(t, { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_use_id: "tuP", tool_input: { command: "rm -rf build" } }); expect("wait" in r).toBe(true);
    expect(loadTask(s.db, t)!.status).toBe("waiting_input"); expect(s.permits.active()).toBe(1);        // lease kept for permission questions (B4/I6 exception)
    s.svc.answer(t, "허용", null); expect((await (r as any).wait).hookSpecificOutput.decision.behavior).toBe("allow");
    await s.settle(); expect(loadTask(s.db, t)!.status).toBe("running"); expect(s.runner.calls.map((c) => c.kind)).toEqual(["spawn"]);   // no stop/resume flapping
    s.hook(t, { hook_event_name: "Stop", last_assistant_message: "working…", background_tasks: [], session_crons: [], prompt_id: "p1" });   // needs_review after a marker-less turn
    s.svc.answer(t, "계속해", null); await s.settle(); expect(loadTask(s.db, t)!.status).toBe("starting"); expect(s.lastStart()).toBe("resume");
  });
  test("interrupt → stop → cancelled; retry → resume; close needs the confirmed API and rm's", async () => {
    const s = setup(); s.svc.applyDecision(s.userMsg("a"), { action: "new_task", project: "myapp", title: "a", size: "normal", prompt: "a", confidence: "high" }); await s.settle();
    const t = (s.db.query("select uuid from tasks").get() as any).uuid; s.hook(t, { hook_event_name: "SessionStart", source: "startup" });
    s.svc.interrupt(t); await s.settle(); expect(loadTask(s.db, t)!.status).toBe("cancelled"); expect(s.permits.active()).toBe(0);
    s.svc.retry(t); await s.settle(); expect(loadTask(s.db, t)!.status).toBe("starting"); expect(s.lastStart()).toBe("resume");
    s.svc.close(t); await s.settle(); expect(loadTask(s.db, t)!.status).toBe("closed"); expect(s.runner.calls.at(-1)!.kind).toBe("rm");
  });
  test("closing a task that ran three generations disposes of all three, stopping each before removing it", async () => {
    const s = setup(); s.svc.applyDecision(s.userMsg("a"), { action: "new_task", project: "myapp", title: "a", size: "normal", prompt: "a", confidence: "high" }); await s.settle();
    const t = (s.db.query("select uuid from tasks").get() as any).uuid;
    s.runner.rows.clear();
    // three forks: each one rebound tasks.session_id, so only process_instances still knows the earlier two
    for (const [g, short] of [[1, "g1"], [2, "g2"], [3, "g3"]] as [number, string][]) {
      s.runner.rows.set(short, { short_id: short, session_id: `s-${short}`, name: "relay:T-01 a", cwd: "/tmp/myapp", pid: g, alive: true, busy: false, waiting_for: null, raw: {} });
      s.log.emit({ type: "process.started", task_uuid: t, process_generation: g, payload: { generation: g, session_id: `s-${short}` } });   // ingest's payload shape: no short id
      s.log.emit({ type: "task.patched", task_uuid: t, payload: { patch: { short_id: short } } });                                          // the outbox stamps it afterwards, on the task only
    }
    expect(s.db.query("select count(*) c from process_instances where task_uuid=? and short_id is not null").get(t)).toEqual({ c: 0 });
    s.runner.calls.length = 0;
    s.svc.close(t); await s.outbox.run(t);
    expect(loadTask(s.db, t)!.status).toBe("closed");
    expect(s.runner.calls.map((c) => `${c.kind} ${c.args}`)).toEqual(["stop g3", "stop g1", "stop g2", "rm g3", "rm g1", "rm g2"]);   // every session stopped before any is removed — they share one worktree
    expect([...s.runner.rows.keys()]).toEqual([]);                                                    // none left registered with the CLI
    expect(s.db.query("select count(*) c from commands where state<>'applied'").get()).toEqual({ c: 0 });   // I5: a closed task keeps no pending commands
  });
  test("close_task decision only posts a confirmation message", () => {
    const s = setup(); s.svc.applyDecision(s.userMsg("a"), { action: "new_task", project: "myapp", title: "a", size: "normal", prompt: "a", confidence: "high" });
    s.svc.applyDecision(s.userMsg("닫아"), { action: "close_task", task_id: "T-01", confidence: "high" });
    expect(s.db.query("select text from messages where role='system' order by rowid desc limit 1").get()).toMatchObject({ text: expect.stringContaining("[close confirm: POST /api/tasks/") });
    expect(loadTask(s.db, (s.db.query("select uuid from tasks").get() as any).uuid)!.status).not.toBe("closed");
  });
  test("kill switch pauses running tasks (stop) and resume-all resumes them", async () => {
    const s = setup(); s.svc.applyDecision(s.userMsg("a"), { action: "new_task", project: "myapp", title: "a", size: "normal", prompt: "a", confidence: "high" }); await s.settle();
    const t = (s.db.query("select uuid from tasks").get() as any).uuid; s.hook(t, { hook_event_name: "SessionStart", source: "startup" });
    s.svc.pause(); await s.settle(); expect(loadTask(s.db, t)!.paused).toBe(true); expect(loadTask(s.db, t)!.status).toBe("running"); expect(s.runner.calls.at(-1)!.kind).toBe("stop");
    s.svc.resumeAll(); await s.settle(); expect(loadTask(s.db, t)!.paused).toBe(false); expect(s.lastStart()).toBe("resume");
  });
  test("attach lease holds sends and yields the right terminal command", async () => {
    const s = setup(); s.svc.applyDecision(s.userMsg("a"), { action: "new_task", project: "myapp", title: "a", size: "normal", prompt: "a", confidence: "high" }); await s.settle();
    const t = (s.db.query("select uuid from tasks").get() as any).uuid; s.hook(t, { hook_event_name: "SessionStart", source: "startup" });
    expect(s.svc.attachLease(t, "cli").command).toMatch(/^claude attach fake1$/);
    s.svc.applyDecision(s.userMsg("x"), { action: "route_to_task", task_id: "T-01", prompt: "x", confidence: "high" }); await s.settle();
    expect(s.db.query("select state from commands where kind='send'").get()).toEqual({ state: "pending" });
    s.svc.releaseAttach(t); await s.settle(); expect(s.db.query("select state from commands where kind='send'").get()).toEqual({ state: "applied" });
  });
  test("new_task commits task, decision mark, badge, started chat and spawn command in one batch (consecutive seqs)", () => {
    const s = setup(); const m = s.userMsg("x"); const before = (s.db.query("select max(seq) m from events").get() as any).m;
    s.svc.applyDecision(m, { action: "new_task", project: "myapp", title: "t", size: "small", prompt: "x", confidence: "high" }, { chain_prev_id: null });
    expect(s.db.query("select type from events where seq>? order by seq").all(before).map((r: any) => r.type).slice(0, 5)).toEqual(["task.created", "dispatch.completed", "message.received", "message.received", "command.queued"]);   // the scheduler's own events follow
    expect(s.db.query("select dispatch_state, task_uuid from messages where id=?").get(m.id)).toEqual({ dispatch_state: "dispatched", task_uuid: (s.db.query("select uuid from tasks").get() as any).uuid });
  });
});
