import { describe, expect, test } from "bun:test";
import { buildTestApp } from "../helpers/app.ts";
import { hookTokenFor } from "../../src/gateway/auth.ts";
import { loadTask } from "../../src/core/events.ts";
import stopDone from "../fixtures/stop-done.json"; import stopQuestion from "../fixtures/stop-question.json";
const decide = (o: unknown) => async () => ({ code: 0, stdout: JSON.stringify({ structured_output: o, usage: { input_tokens: 10, output_tokens: 1 } }), stderr: "" });
describe("pipeline: message → dispatch → task → hooks → ws", () => {
  test("new task lifecycle end to end with WS frames", async () => {
    const s = await buildTestApp(decide({ action: "new_task", project: "myapp", title: "auth 리팩토링", size: "normal", prompt: "auth 리팩토링 해줘", confidence: "high" }));
    const frames: any[] = []; s.hub.handleOpen({ send: (x: string) => frames.push(JSON.parse(x)) } as any, 0);
    const r = await s.req("POST", "/api/messages", { text: "auth 리팩토링 해줘", client_message_id: "c1" }); expect(r.status).toBe(202);
    await new Promise((x) => setTimeout(x, 80));
    const t = s.db.query("select * from tasks").get() as any; expect(t.status).toBe("starting"); expect(s.runner.calls[0].kind).toBe("spawn");
    const row = s.runner.rows.get(t.short_id)!;
    // hooks arrive with the hook token + task header
    const hookReq = (b: any) => s.app.request("http://127.0.0.1:8790/api/hooks", { method: "POST", headers: { host: "127.0.0.1:8790", authorization: `Bearer ${hookTokenFor("HOOK", t.uuid)}`, "content-type": "application/json", "x-relay-task": t.uuid }, body: JSON.stringify({ ...b, session_id: row.session_id, transcript_path: "/dev/null", cwd: row.cwd }) });
    expect((await hookReq({ hook_event_name: "SessionStart", source: "startup" })).status).toBe(200); expect(loadTask(s.db, t.uuid)!.status).toBe("running");
    await hookReq({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "tu1", tool_input: { file_path: "/tmp/myapp/src/auth.ts" } });
    expect(loadTask(s.db, t.uuid)!.last_step).toBe("Edit src/auth.ts");
    await hookReq({ ...(stopQuestion as any), prompt_id: "turn-1" }); expect(loadTask(s.db, t.uuid)!.status).toBe("waiting_input"); expect(s.permits.active()).toBe(0);
    const ans = await s.req("POST", "/api/messages", { text: "a.txt", client_message_id: "c2", reply_to_task_id: t.uuid }); expect(ans.status).toBe(202);
    await new Promise((x) => setTimeout(x, 80)); expect(s.runner.calls.map((c) => `${c.kind}`)).toEqual(["spawn", "stop", "resume", "stop"]);   // the trailing stop reaps the session the fork superseded — through the real hook path, where process_instances has no short id
    expect(s.runner.rows.get(String((s.runner.calls[1] as any).args))!.alive).toBe(false);     // the superseded session is stopped, and kept until close: the fork is live in its worktree
    expect(s.runner.rows.get(loadTask(s.db, t.uuid)!.short_id!)!.alive).toBe(true);            // the live one is untouched
    await hookReq({ hook_event_name: "SessionStart", source: "resume" }); await hookReq({ ...(stopDone as any), prompt_id: "turn-2" });   // a new turn after --resume has a new prompt_id
    expect(loadTask(s.db, t.uuid)!.status).toBe("done");
    const types = frames.map((f) => f.type); for (const k of ["hello", "chat.message", "dispatch.updated", "task.created", "task.updated", "task.event", "system.state"]) expect(types).toContain(k);
    expect(frames.every((f, i) => i === 0 || f.seq >= frames[i - 1].seq)).toBe(true);
    const snap = (await (await s.req("GET", "/api/tasks")).json()) as any; expect(snap.tasks[0].status).toBe("done"); expect(snap.messages.map((m: any) => m.role)).toEqual(["user", "system", "system", "question", "user", "worker_summary"]);   // user → dispatcher badge → started → question → reply → summary
    expect(s.invariants()).toEqual([]);
  });
  test("cap 1: second task queues and starts when the first finishes; kill switch holds spawn", async () => {
    const s = await buildTestApp(decide({ action: "new_task", project: "myapp", title: "t", size: "small", prompt: "p", confidence: "high" }));
    s.setMax(1); s.db.run("insert into meta(key,value) values('max_concurrent_agents','1')");
    await s.req("POST", "/api/messages", { text: "a", client_message_id: "a" }); await s.req("POST", "/api/messages", { text: "b", client_message_id: "b" }); await new Promise((x) => setTimeout(x, 120));
    const [ta, tb] = s.db.query("select * from tasks order by num").all() as any[]; expect(ta.status).toBe("starting"); expect(tb.status).toBe("queued");
    expect(s.runner.calls.filter((c) => c.kind === "spawn").length).toBe(1);
    await s.req("POST", `/api/tasks/${ta.uuid}/interrupt`); await new Promise((x) => setTimeout(x, 80)); expect((s.db.query("select status from tasks where uuid=?").get(tb.uuid) as any).status).toBe("starting");
    expect(s.runner.calls.filter((c) => c.kind === "spawn").length).toBe(2); expect(s.invariants()).toEqual([]);
  });
  test("a spawn whose outcome relay could not read returns the slot: the task is visible and the next task still starts", async () => {
    const s = await buildTestApp(decide({ action: "new_task", project: "myapp", title: "t", size: "small", prompt: "p", confidence: "high" }));
    s.setMax(1); s.db.run("insert into meta(key,value) values('max_concurrent_agents','1')");
    const ok = s.runner.spawn.bind(s.runner); let first = true;
    s.runner.spawn = async (spec: any) => { if (!first) return ok(spec); first = false; s.runner.calls.push({ kind: "spawn", args: spec }); throw new Error("spawn failed (1): no `backgrounded ·` line"); };
    await s.req("POST", "/api/messages", { text: "a", client_message_id: "a" }); await new Promise((x) => setTimeout(x, 120));
    const ta = s.db.query("select * from tasks order by num").get() as any;
    expect(ta.status).toBe("error");                                                     // not a silent `starting` with no process
    expect(s.permits.active()).toBe(0);                                                  // the slot came back
    expect((s.db.query("select state from commands where task_uuid=?").get(ta.uuid) as any).state).toBe("unknown");   // B3: the operator confirms or retries
    expect(s.invariants()).toEqual([]);
    await s.req("POST", "/api/messages", { text: "b", client_message_id: "b" }); await new Promise((x) => setTimeout(x, 120));
    const tb = s.db.query("select * from tasks where num=2").get() as any;
    expect(tb.status).toBe("starting"); expect(s.runner.calls.filter((c) => c.kind === "spawn").length).toBe(2);       // the freed slot went to the next task
    expect(s.invariants()).toEqual([]);
  });
  test("frames of one event share its seq and carry idx 0..n-1 (the dashboard cursor is (seq, idx))", async () => {
    const s = await buildTestApp(); const frames: any[] = []; s.hub.handleOpen({ send: (x: string) => frames.push(JSON.parse(x)) } as any, 0);
    s.seedTask("running");                                                   // task.created → [task.created, system.state] in ONE event
    const seq = frames.at(-1).seq; const group = frames.filter((f) => f.seq === seq);
    expect(group.map((f) => f.type)).toEqual(["task.created", "system.state"]); expect(group.map((f) => f.idx)).toEqual([0, 1]);
  });
});
