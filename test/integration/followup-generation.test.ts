import { expect, test } from "bun:test";
import { buildTestApp } from "../helpers/app.ts";
import { loadTask } from "../../src/core/events.ts";

// Real --bg follow-ups emit fork SessionStart before resume() returns. No recent
// spawn/resume command may accidentally authorize the send's new identity.
for (const endBeforeFork of [true, false]) {
  test(`follow-up binds its fork and ignores its predecessor ending ${endBeforeFork ? "before" : "after"} the fork`, async () => {
    const s = await buildTestApp();
    const uuid = s.seedTask("done", { turn_state: "idle" });
    const old = loadTask(s.db, uuid)!;
    s.log.emit({ type: "process.started", task_uuid: uuid, process_generation: 1, payload: { generation: 1, session_id: old.session_id } });
    const endOld = () => s.hookReq(uuid, { hook_event_name: "SessionEnd", session_id: old.session_id, relay_gen: 1, reason: "other" });
    const stop = s.runner.stop.bind(s.runner);
    s.runner.stop = async id => { await stop(id); if (id === old.short_id && endBeforeFork) await endOld(); };
    const resume = s.runner.resume.bind(s.runner);
    s.runner.resume = async spec => {
      const result = await resume(spec); const row = s.runner.rows.get(result.short_id)!;
      const response = await s.hookReq(uuid, { hook_event_name: "SessionStart", source: "fork", session_id: row.session_id, relay_gen: 2, cwd: row.cwd });
      expect(response.status).toBe(200);
      if (!endBeforeFork) await endOld();
      await s.hookReq(uuid, { hook_event_name: "UserPromptSubmit", session_id: row.session_id, relay_gen: 2, prompt_id: "second-turn", prompt: "follow-up" });
      return result;
    };
    await s.req("POST", "/api/messages", { text: "follow-up", reply_to_task_id: uuid, client_message_id: "follow-up" });
    await s.settle(100); await s.outbox.run(uuid);
    const current = loadTask(s.db, uuid)!;
    expect(current.process_generation).toBe(2);
    expect(current.session_id).not.toBe(old.session_id);
    expect(current.status).toBe("running");
    expect(current.process_state).toBe("alive");
    expect(s.db.query("select count(*) n from messages where role='error'").get()).toEqual({ n: 0 });
    expect(s.permits.active()).toBe(1);
    expect(s.invariants()).toEqual([]);
    // A crash of the replacement is still a crash, even while a send exists.
    await s.hookReq(uuid, { hook_event_name: "SessionEnd", session_id: current.session_id, relay_gen: 2, reason: "other" });
    expect(loadTask(s.db, uuid)!.status).toBe("error");
    expect(s.permits.active()).toBe(0);
  });
}

test("resume-all clears pause before an early fork Stop and consumes an already queued follow-up", async () => {
  const s = await buildTestApp(); const uuid = s.seedTask("running", { turn_state: "busy" });
  const old = loadTask(s.db, uuid)!;
  s.permits.acquire({ holder_kind: "task", holder_id: `task:${uuid}`, task_uuid: uuid });
  s.log.emit({ type: "process.started", task_uuid: uuid, process_generation: 1, payload: { generation: 1, session_id: old.session_id } });
  await s.req("POST", "/api/messages", { text: "queued follow-up", reply_to_task_id: uuid, client_message_id: "busy" });
  await s.req("POST", "/api/pause"); await s.outbox.run(uuid);
  const resume = s.runner.resume.bind(s.runner);
  s.runner.resume = async spec => {
    const r = await resume(spec); const row = s.runner.rows.get(r.short_id)!;
    await s.hookReq(uuid, { hook_event_name: "SessionStart", source: "fork", session_id: row.session_id, relay_gen: 2, cwd: row.cwd });
    expect(loadTask(s.db, uuid)!.paused).toBe(false);
    await s.hookReq(uuid, { hook_event_name: "Stop", session_id: row.session_id, relay_gen: 2, prompt_id: "resumed-done", last_assistant_message: "RELAY: done\nFollow-up applied." });
    return r;
  };
  await s.req("POST", "/api/resume-all"); await s.settle(100); await s.outbox.run(uuid);
  expect(loadTask(s.db, uuid)!.status).toBe("done");
  expect(s.runner.calls.filter(c => c.kind === "resume")).toHaveLength(1);
  expect(s.db.query("select count(*) n from commands where state in ('pending','running','unknown')").get()).toEqual({ n: 0 });
  expect(s.permits.active()).toBe(0);
});

test("a busy follow-up starts after the completed turn returns its slot", async () => {
  const s = await buildTestApp(); const uuid = s.seedTask("running", { turn_state: "busy" });
  s.permits.acquire({ holder_kind: "task", holder_id: `task:${uuid}`, task_uuid: uuid });
  await s.req("POST", "/api/messages", { text: "next change", reply_to_task_id: uuid, client_message_id: "busy-next" });
  await s.settle();
  expect(s.runner.calls.filter(c => c.kind === "resume")).toHaveLength(0);
  await s.hookReq(uuid, { hook_event_name: "Stop", session_id: loadTask(s.db, uuid)!.session_id, relay_gen: 1, prompt_id: "first-done", last_assistant_message: "RELAY: done\nFirst change committed." });
  await s.settle(100);
  expect(s.runner.calls.filter(c => c.kind === "resume")).toHaveLength(1);
  expect((s.db.query("select state from commands where kind='send'").get() as any).state).toBe("applied");
  expect(s.permits.active()).toBe(1);
  expect(s.invariants()).toEqual([]);
});

test("a send that never selected resume cannot authorize a fork or hide a crash", async () => {
  const s = await buildTestApp(); const uuid = s.seedTask("running");
  const t = loadTask(s.db, uuid)!;
  s.log.emit({ type: "command.queued", task_uuid: uuid, payload: { id: "socket-send", kind: "send", payload: { kind: "send", text: "hello", marker: "abcdef12" } } });
  s.log.emit({ type: "command.running", task_uuid: uuid, causation_id: "socket-send", process_generation: 1, payload: { id: "socket-send" } });
  const fork = await s.hookReq(uuid, { hook_event_name: "SessionStart", source: "fork", session_id: "uninvited", relay_gen: 2 });
  expect(fork.status).toBe(202);
  expect(loadTask(s.db, uuid)!.session_id).toBe(t.session_id);
  await s.hookReq(uuid, { hook_event_name: "SessionEnd", session_id: t.session_id, relay_gen: 1, reason: "other" });
  expect(loadTask(s.db, uuid)!.status).toBe("error");
});

test("a new kill switch during a fork is not cleared by its start hook or acknowledgement", async () => {
  const s = await buildTestApp(); const uuid = s.seedTask("done", { turn_state: "idle" });
  const resume = s.runner.resume.bind(s.runner);
  s.runner.resume = async spec => {
    const result = await resume(spec); const row = s.runner.rows.get(result.short_id)!;
    s.svc.pause();
    await s.hookReq(uuid, { hook_event_name: "SessionStart", source: "fork", session_id: row.session_id, relay_gen: 2, cwd: row.cwd });
    expect(loadTask(s.db, uuid)!.paused).toBe(true);
    return result;
  };
  await s.req("POST", "/api/messages", { text: "resume", reply_to_task_id: uuid, client_message_id: "pause-during-resume" });
  await s.settle(100);
  expect(s.svc.paused()).toBe(true);
  expect(loadTask(s.db, uuid)!.paused).toBe(true);
  expect(loadTask(s.db, uuid)!.process_state).toBe("stopped");
});
