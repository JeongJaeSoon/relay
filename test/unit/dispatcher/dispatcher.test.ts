import { describe, expect, test } from "bun:test";
import { openDb, migrate } from "../../../src/db/db.ts";
import { EventLog, loadMessage } from "../../../src/core/events.ts";
import { parseConfig } from "../../../src/config.ts";
import { Dispatcher, type RunClaude } from "../../../src/dispatcher/dispatcher.ts";
import { ulid } from "../../../src/core/ids.ts";

const cfg = parseConfig("[dispatcher]\ntimeout_ms = 200\n");
function setup(run: RunClaude) {
  const db = openDb(":memory:"); migrate(db); const log = new EventLog(db, () => {}, cfg);
  db.run("insert into projects(id,name,path,created_at) values('p1','myapp','/tmp/myapp',1)");
  const decisions: any[] = []; const confirms: any[] = [];
  const d = new Dispatcher(db, log, cfg, { runClaude: run, onDecision: (m, x, p) => { decisions.push([m.id, x]); log.emit({ type: "dispatch.completed", payload: { message_id: m.id, patch: { dispatch_state: "dispatched", dispatch_json: x, ...p } } }); }, /* A9: what TaskService.applyDecision commits */ onNeedsConfirm: (m, x, r) => confirms.push([m.id, x, r]), isPaused: () => false });
  const msg = (text: string) => { const id = ulid(); log.emit({ type: "message.received", payload: { id, role: "user", source: "user", client_message_id: id, dispatch_state: "pending", text, task_uuid: null, reply_to_task_uuid: null, dispatch_json: null, dispatch_error: null, created_at: 1 } }); return id; };
  return { db, log, d, msg, decisions, confirms };
}
const ok = (obj: unknown): RunClaude => async () => ({ code: 0, stdout: JSON.stringify({ structured_output: obj, session_id: "x", duration_ms: 5, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 }), stderr: "" });
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("Dispatcher", () => {
  test("valid decision → dispatched + onDecision", async () => {
    const s = setup(ok({ action: "new_task", project: "myapp", title: "auth 리팩토링", size: "normal", prompt: "auth 리팩토링 해줘", confidence: "high" }));
    const id = s.msg("auth 리팩토링 해줘"); s.d.enqueue(id); await settle();
    expect(loadMessage(s.db, id)!.dispatch_state).toBe("dispatched"); expect(s.decisions[0][1].action).toBe("new_task");
  });
  test("fast-path answers without calling claude", async () => {
    let calls = 0; const s = setup(async () => { calls++; return { code: 0, stdout: "", stderr: "" }; });
    const id = s.msg("상태?"); s.d.enqueue(id); await settle();
    expect(calls).toBe(0); expect(loadMessage(s.db, id)!.dispatch_state).toBe("fastpath");
    expect(s.db.query("select count(*) c from messages where role='dispatcher_answer'").get()).toEqual({ c: 1 });
  });
  test("invalid JSON then valid on retry (high effort)", async () => {
    const seen: string[] = []; let n = 0;
    const s = setup(async (args) => { seen.push(args[args.indexOf("--effort") + 1]); return n++ === 0 ? { code: 0, stdout: "garbage", stderr: "" } : ok({ action: "answer_directly", answer: "42", confidence: "high" })(args, { cwd: "", timeoutMs: 0 }); });
    const id = s.msg("인생의 의미는?"); s.d.enqueue(id); await settle();
    expect(seen).toEqual(["medium", "high"]); expect(loadMessage(s.db, id)!.dispatch_state).toBe("dispatched");
  });
  test("low twice → needs_confirm", async () => {
    const s = setup(ok({ action: "route_to_task", task_id: "T-01", confidence: "low" }));
    const id = s.msg("그거 해줘"); s.d.enqueue(id); await settle();
    expect(loadMessage(s.db, id)!.dispatch_state).toBe("needs_confirm"); expect(s.confirms.length).toBe(1); expect(s.decisions.length).toBe(0);
  });
  test("timeout → failed, chain continues", async () => {
    let n = 0; const s = setup(async (args, o) => { if (n++ === 0) { await new Promise((r) => setTimeout(r, o.timeoutMs + 100)); return { code: 143, stdout: "", stderr: "" }; } return ok({ action: "answer_directly", answer: "ok", confidence: "high" })(args, o); });
    const a = s.msg("느린 질문"); const b = s.msg("빠른 질문"); s.d.enqueue(a); s.d.enqueue(b); await new Promise((r) => setTimeout(r, 700));
    expect(loadMessage(s.db, a)!.dispatch_state).toBe("failed"); expect(loadMessage(s.db, b)!.dispatch_state).toBe("dispatched");
  });
  test("messages are decided strictly in order", async () => {
    const order: string[] = []; const s = setup(async (args) => { order.push(args.at(-1)!.split("[user message]\n")[1]); await settle(); return ok({ action: "answer_directly", answer: "x", confidence: "high" })(args, { cwd: "", timeoutMs: 0 }); });
    ["1번", "2번", "3번"].forEach((t) => s.d.enqueue(s.msg(t))); await new Promise((r) => setTimeout(r, 200));
    expect(order).toEqual(["1번", "2번", "3번"]);
  });
});

// `--max-turns 1` cuts the model off before it emits the structured output whenever it thinks first: measured against
// 2.1.251 on a real Ask prompt, 1 gave `terminal_reason:"max_turns"` and `structured_output: undefined`, 2 completed.
// Routing shares the same call and was failing the same way whenever the model reasoned before answering.
test("the model call leaves room for the structured output to be emitted after thinking", async () => {
  const seen: string[][] = [];
  const s = setup(async (args) => { seen.push(args); return ok({ action: "answer_directly", answer: "ok", confidence: "high" })(args, { cwd: "", timeoutMs: 0 }); });
  const id = s.msg("인생의 의미는?"); s.d.enqueue(id); await settle();
  const args = seen[0]; const i = args.indexOf("--max-turns");
  expect(i).toBeGreaterThan(-1);
  expect(Number(args[i + 1])).toBeGreaterThanOrEqual(2);
});
