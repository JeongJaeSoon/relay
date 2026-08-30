import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markAsk } from "@shared/ask.ts";
import { openDb, migrate } from "../../../src/db/db.ts";
import { EventLog, loadMessage } from "../../../src/core/events.ts";
import { parseConfig } from "../../../src/config.ts";
import { Dispatcher, type RunClaude } from "../../../src/dispatcher/dispatcher.ts";
import { ulid } from "../../../src/core/ids.ts";

const cfg = parseConfig("[dispatcher]\ntimeout_ms = 200\n");
function setup(run: RunClaude) {
  const db = openDb(":memory:"); migrate(db); const log = new EventLog(db, () => {}, cfg);
  db.run("insert into projects(id,name,path,created_at) values('p1','myapp','/tmp/myapp',1)");
  db.run("insert into tasks(uuid,num,display_id,project_id,title,status,size,effort,model,process_generation,created_at,updated_at) values('u1',2,'T-02','p1','auth','running','normal','xhigh','m',1,1,1)");
  const decisions: any[] = []; const confirms: any[] = [];
  const d = new Dispatcher(db, log, cfg, { runClaude: run, onDecision: (m, x, p) => { decisions.push([m.id, x]); log.emit({ type: "dispatch.completed", payload: { message_id: m.id, patch: { dispatch_state: "dispatched", dispatch_json: x, ...p } } }); }, onNeedsConfirm: (m, x, r) => confirms.push([m.id, x, r]), isPaused: () => false });
  const msg = (text: string, taskUuid: string | null = null) => { const id = ulid(); log.emit({ type: "message.received", payload: { id, role: "user", source: "user", client_message_id: id, dispatch_state: "pending", text, task_uuid: taskUuid, reply_to_task_uuid: null, dispatch_json: null, dispatch_error: null, created_at: 1 } }); return id; };
  return { db, log, d, msg, decisions, confirms };
}
const ok = (obj: unknown): RunClaude => async () => ({ code: 0, stdout: JSON.stringify({ structured_output: obj, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 }), stderr: "" });
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("Ask mode", () => {
  test("a question is answered, never dispatched — the model's action is ignored", async () => {
    const s = setup(ok({ action: "new_task", project: "myapp", title: "auth", size: "normal", answer: "T-02 failed because bun test timed out.", confidence: "high" }));
    const id = s.msg(markAsk("why did T-02 fail")); s.d.enqueue(id); await settle();
    expect(s.decisions.length).toBe(1);
    expect(s.decisions[0][1]).toEqual({ action: "answer_directly", answer: "T-02 failed because bun test timed out.", confidence: "high" });
    expect(loadMessage(s.db, id)!.dispatch_json!.action).toBe("answer_directly");
    expect(s.db.query("select count(*) c from tasks").get()).toEqual({ c: 1 });   // only the seeded one
  });
  test("a model that answers with a routing decision and no answer is a failed call, not a task", async () => {
    const s = setup(ok({ action: "new_task", project: "myapp", title: "auth", size: "normal", prompt: "do it", confidence: "high" }));
    const id = s.msg(markAsk("refactor auth in myapp")); s.d.enqueue(id); await settle();
    const m = loadMessage(s.db, id)!;
    expect(m.dispatch_state).toBe("failed"); expect(m.dispatch_error).toContain("answer");
    expect(s.decisions.length).toBe(0); expect(s.confirms.length).toBe(0);
  });
  test("the ask prompt carries no routing context and no routing actions, and the marker never reaches the model", async () => {
    let seen: string[] = []; const s = setup(async (args) => { seen = args; return ok({ answer: "42" })(args, { cwd: "", timeoutMs: 0 }); });
    const id = s.msg(markAsk("why did T-02 fail")); s.d.enqueue(id); await settle();
    const prompt = seen.at(-1)!; const system = seen[seen.indexOf("--append-system-prompt") + 1]; const schema = seen[seen.indexOf("--json-schema") + 1];
    expect(prompt).toBe("[user message]\nwhy did T-02 fail");
    expect(prompt).not.toContain("[projects]"); expect(prompt).not.toContain("[active tasks]"); expect(prompt).not.toContain("[recent chat]");
    expect(prompt).not.toContain("?");
    expect(schema).not.toContain("new_task"); expect(schema).not.toContain("route_to_task"); expect(schema).not.toContain("close_task");
    expect(system).not.toContain("new_task");
    expect(loadMessage(s.db, id)!.dispatch_state).toBe("dispatched");
  });
  test("the ask prompt is a fraction of a routing prompt", async () => {
    const sizes: number[] = []; const s = setup(async (args) => { sizes.push(args.at(-1)!.length + args[args.indexOf("--append-system-prompt") + 1].length + args[args.indexOf("--json-schema") + 1].length); return ok({ action: "answer_directly", answer: "x", confidence: "high" })(args, { cwd: "", timeoutMs: 0 }); });
    s.d.enqueue(s.msg("why did T-02 fail")); await settle();
    s.d.enqueue(s.msg(markAsk("why did T-02 fail"))); await settle();
    expect(sizes.length).toBe(2); expect(sizes[1]).toBeLessThan(sizes[0] / 2);
  });
  test("a status question in Ask mode still takes the fast path — no LLM call", async () => {
    let calls = 0; const s = setup(async () => { calls++; return { code: 0, stdout: "", stderr: "" }; });
    const id = s.msg(markAsk("상태?")); s.d.enqueue(id); await settle();
    expect(calls).toBe(0); expect(loadMessage(s.db, id)!.dispatch_state).toBe("fastpath");
    expect(s.db.query("select count(*) c from messages where role='dispatcher_answer'").get()).toEqual({ c: 1 });
  });
  test("a task-scoped question reads that task's state and transcript, and never touches the worker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-ask-")); const path = join(dir, "t.jsonl");
    writeFileSync(path, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "the migration keeps failing on a locked table" }] } }) + "\n");
    let seen: string[] = []; const s = setup(async (args) => { seen = args; return ok({ answer: "It is blocked on a locked table." })(args, { cwd: "", timeoutMs: 0 }); });
    s.db.run("update tasks set last_step='Bash bun test' where uuid='u1'");
    s.db.run("insert into events(event_id,type,task_uuid,occurred_at,recorded_at,payload_json) values('e1','hook.PostToolUse','u1',1,1,?)", [JSON.stringify({ tool_name: "Bash", transcript_path: path })]);
    const id = s.msg(markAsk("why is T-02 stuck"), "u1"); s.d.enqueue(id); await settle();
    const prompt = seen.at(-1)!;
    expect(prompt).toContain("[task T-02]"); expect(prompt).toContain("last step: Bash bun test");
    expect(prompt).toContain("the migration keeps failing on a locked table");
    expect(prompt.endsWith("[user message]\nwhy is T-02 stuck")).toBe(true);
    expect(seen).toContain("--no-session-persistence");                          // no session, no transcript, nothing to archive
    expect(s.decisions[0][1]).toEqual({ action: "answer_directly", answer: "It is blocked on a locked table.", confidence: "high" });
    expect(s.db.query("select count(*) c from commands where task_uuid='u1'").get()).toEqual({ c: 0 });   // the worker was never sent anything
  });
  test("a task-scoped question that the model answers with a routing decision still makes no task", async () => {
    const s = setup(ok({ action: "route_to_task", task_id: "T-02", prompt: "look into it", confidence: "high" }));
    const id = s.msg(markAsk("why is T-02 stuck"), "u1"); s.d.enqueue(id); await settle();
    expect(loadMessage(s.db, id)!.dispatch_state).toBe("failed");
    expect(s.decisions.length).toBe(0);
    expect(s.db.query("select count(*) c from commands").get()).toEqual({ c: 0 });
  });
  test("a task-scoped question is never the system status fast path", async () => {
    let calls = 0; const s = setup(async (args) => { calls++; return ok({ answer: "T-02 is running." })(args, { cwd: "", timeoutMs: 0 }); });
    const id = s.msg(markAsk("status?"), "u1"); s.d.enqueue(id); await settle();
    expect(calls).toBe(1);                                                       // the fast path answers for the whole system, not for T-02
    expect(loadMessage(s.db, id)!.dispatch_state).toBe("dispatched");
  });
  test("a plain message is still routed by the dispatcher", async () => {
    const s = setup(ok({ action: "new_task", project: "myapp", title: "auth", size: "normal", prompt: "refactor auth", confidence: "high" }));
    const id = s.msg("refactor auth in myapp"); s.d.enqueue(id); await settle();
    expect(loadMessage(s.db, id)!.dispatch_state).toBe("dispatched"); expect(s.decisions[0][1].action).toBe("new_task");
  });
});
