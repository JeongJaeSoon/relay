import { expect, test } from "bun:test";
import { buildTestApp, decide } from "../helpers/app.ts";
import { loadTask } from "../../src/core/events.ts";

// Spawn and generation identities arrive through the HTTP/dispatcher/hook production path.
async function forkedTask() {
  const s = await buildTestApp(decide({ action: "new_task", project: "myapp", title: "cleanup", size: "small", prompt: "read only", confidence: "high" }));
  await s.req("POST", "/api/messages", { text: "read only", client_message_id: "start" }); await s.settle(100);
  const uuid = (s.db.query("select uuid from tasks").get() as any).uuid;
  const start = async () => {
    const t = loadTask(s.db, uuid)!; const row = s.runner.rows.get(t.short_id!)!;
    await s.hookReq(uuid, { hook_event_name: "SessionStart", source: "startup", session_id: row.session_id, cwd: row.cwd });
  };
  await start();
  const first = loadTask(s.db, uuid)!.short_id!;
  s.log.emit({ type: "task.patched", task_uuid: uuid, payload: { patch: { turn_state: "idle" } } });
  s.outbox.enqueue(uuid, "followup", { kind: "send", text: "continue", marker: "1234abcd" }); await s.outbox.run(uuid);
  await start();
  return { ...s, uuid, first, last: loadTask(s.db, uuid)!.short_id! };
}

test("close during a superseded stop waits for evidence; retry drains every generation and preserves foreign rows", async () => {
  const s = await forkedTask();
  const foreign = { ...s.runner.rows.get(s.last)!, short_id: "foreign", session_id: "foreign-session", cwd: "/elsewhere" };
  s.runner.rows.set("foreign", foreign);
  // The supervisor brought an older process back after its earlier stop succeeded.
  s.runner.rows.get(s.first)!.alive = true;
  const original = s.runner.stop.bind(s.runner);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => enter = r), gate = new Promise<void>(r => release = r);
  s.runner.stop = async short => { if (short === s.first) { enter(); await gate; throw new Error("lost stop acknowledgement"); } await original(short); };
  const c = s.outbox.enqueue(s.uuid, "retry-old-stop", { kind: "stop", reason: "supervisor restart", target: { session_id: s.runner.rows.get(s.first)!.session_id!, short_id: s.first } });
  await entered;
  expect((await s.req("POST", `/api/tasks/${s.uuid}/close`)).status).toBe(200);
  release(); await s.outbox.run(s.uuid);
  expect(s.runner.calls.filter(c => c.kind === "rm")).toHaveLength(0);
  expect((s.db.query("select state from commands where id=?").get(c.id) as any).state).toBe("unknown");
  expect(loadTask(s.db, s.uuid)!.status).not.toBe("closed");
  s.runner.stop = original;
  expect((await s.req("POST", `/api/commands/${c.id}/retry`)).status).toBe(200); await s.outbox.run(s.uuid);
  expect(loadTask(s.db, s.uuid)!.status).toBe("closed");
  expect([...s.runner.rows.keys()]).toEqual(["foreign"]);
  expect(s.runner.calls.filter(c => ["stop", "rm"].includes(c.kind)).some(c => c.args === "foreign")).toBe(false);
  expect(s.db.query("select count(distinct session_id) n from process_instances where task_uuid=?").get(s.uuid)).toEqual({ n: 2 });
  expect(s.invariants()).toEqual([]);
});

test("doctor reports unresolved superseded cleanup until the same command is retried", async () => {
  const { pendingCleanup } = await import("../../src/cli/doctor.ts");
  const s = await forkedTask();
  await s.req("POST", `/api/tasks/${s.uuid}/close`); await s.outbox.run(s.uuid);
  expect(pendingCleanup(s.db)).toEqual([]);
  s.runner.list = async () => { throw new Error("roster unavailable"); };
  const c = s.outbox.enqueue(s.uuid, "recheck-old", { kind: "rm", target: { session_id: "older", short_id: null } }); await s.outbox.run(s.uuid);
  expect(pendingCleanup(s.db)).toMatchObject([{ id: c.id, kind: "rm", state: "unknown", session_id: "older", error: "Error: roster unavailable" }]);
  s.runner.list = async () => [];
  await s.req("POST", `/api/commands/${c.id}/retry`); await s.outbox.run(s.uuid);
  expect(pendingCleanup(s.db)).toEqual([]);
});

test("SessionStart and SessionEnd arriving before resume returns survive its acknowledgement", async () => {
  const s = await forkedTask();
  s.log.emit({ type: "task.patched", task_uuid: s.uuid, payload: { patch: { turn_state: "idle" } } });
  const resume = s.runner.resume.bind(s.runner);
  s.runner.resume = async p => {
    const result = await resume(p); const row = s.runner.rows.get(result.short_id)!;
    await s.hookReq(s.uuid, { hook_event_name: "SessionStart", source: "fork", session_id: row.session_id, cwd: row.cwd });
    await s.hookReq(s.uuid, { hook_event_name: "SessionEnd", session_id: row.session_id, reason: "other" });
    row.alive = false;
    return result;
  };
  s.outbox.enqueue(s.uuid, "fast-followup", { kind: "send", text: "continue", marker: "7654abcd" }); await s.outbox.run(s.uuid);
  const t = loadTask(s.db, s.uuid)!;
  expect(t.process_generation).toBe(3);
  expect(t.process_state).toBe("crashed");
  expect(s.db.query("select count(*) n from process_instances where task_uuid=? and ended_at is null").get(s.uuid)).toEqual({ n: 0 });
});

test("close stays visible until every generation rm settles, including a retry after actual removal", async () => {
  const s = await forkedTask(); const rm = s.runner.rm.bind(s.runner);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => enter=r), gate = new Promise<void>(r => release=r);
  s.runner.rm = async short => { if(short===s.first){enter();await gate; await rm(short);throw new Error("lost acknowledgement after removal");}return rm(short); };
  await s.req("POST", `/api/tasks/${s.uuid}/close`); await entered;
  const before = loadTask(s.db,s.uuid)!.status;
  release(); await s.outbox.run(s.uuid);
  expect(before).not.toBe("closed");
  expect(loadTask(s.db,s.uuid)!.status).toBe("error");
  const unknown = s.db.query("select id from commands where kind='rm' and state='unknown'").get() as any;
  s.runner.rm = rm;
  await s.req("POST", `/api/commands/${unknown.id}/retry`); await s.outbox.run(s.uuid);
  expect(loadTask(s.db,s.uuid)!.status).toBe("closed");
  expect(loadTask(s.db,s.uuid)!.last_summary).not.toContain("close did not finish");
  expect(s.runner.rows.size).toBe(0); expect(s.invariants()).toEqual([]);
});

test("cleanup retry from the dashboard retries disposal without spawning another worker", async () => {
  const s = await forkedTask(); s.runner.keepWorktree = { reason: "uncommitted changes" };
  await s.req("POST", `/api/tasks/${s.uuid}/close`); await s.outbox.run(s.uuid);
  const snap = await (await s.req("GET", "/api/tasks")).json() as any;
  expect(snap.tasks.find((t:any)=>t.uuid===s.uuid).cleanup_pending).toBe(true);
  expect(loadTask(s.db,s.uuid)!.cleanup_pending).toBe(true);
  expect((await s.req("POST", `/api/tasks/${s.uuid}/retry`)).status).toBe(409);
  const starts = s.runner.calls.filter(c=>["spawn","resume"].includes(c.kind)).length;
  s.runner.keepWorktree = null;
  expect((await s.req("POST", `/api/tasks/${s.uuid}/retry-cleanup`)).status).toBe(200); await s.outbox.run(s.uuid);
  expect(loadTask(s.db,s.uuid)).toMatchObject({ status: "closed", cleanup_pending: false });
  expect(s.runner.calls.filter(c=>["spawn","resume"].includes(c.kind))).toHaveLength(starts);
  expect(s.runner.rows.size).toBe(0);
});

test("an interrupt with only an unknown stop exposes cleanup retry and blocks restart", async () => {
  const s = await forkedTask(); const stop = s.runner.stop.bind(s.runner);
  s.runner.stop = async () => { throw new Error("stop acknowledgement lost"); };
  await s.req("POST", `/api/tasks/${s.uuid}/interrupt`); await s.outbox.run(s.uuid);
  expect(s.db.query("select count(*) n from commands where kind='rm'").get()).toEqual({ n: 0 });
  expect(loadTask(s.db, s.uuid)).toMatchObject({ status: "cancelled", cleanup_pending: true });
  const snap = await (await s.req("GET", "/api/tasks")).json() as any;
  expect(snap.tasks.find((t: any) => t.uuid === s.uuid).cleanup_pending).toBe(true);
  expect((await s.req("POST", `/api/tasks/${s.uuid}/retry`)).status).toBe(409);
  const starts = s.runner.calls.filter(c => ["spawn", "resume"].includes(c.kind)).length;
  s.runner.stop = stop;
  expect((await s.req("POST", `/api/tasks/${s.uuid}/retry-cleanup`)).status).toBe(200); await s.outbox.run(s.uuid);
  expect(loadTask(s.db, s.uuid)).toMatchObject({ status: "cancelled", cleanup_pending: false, process_state: "stopped" });
  expect(s.runner.calls.filter(c => ["spawn", "resume"].includes(c.kind))).toHaveLength(starts);
});
