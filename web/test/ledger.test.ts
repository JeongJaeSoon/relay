import { expect, test } from "bun:test";
import { needsYou, requestRows } from "../src/ledger.ts";

let seq = 0;
const msg = (over: Record<string, unknown> = {}) => ({ id: `m${++seq}`, role: "user", source: "user", client_message_id: null, dispatch_state: "dispatched", text: "", task_uuid: null, reply_to_task_uuid: null, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: seq * 1000, ...over }) as any;
const task = (uuid: string, display_id: string, status: string, over: Record<string, unknown> = {}) => ({ uuid, num: Number(display_id.slice(2)), display_id, project_id: "p", title: "t", status, size: "normal", effort: "xhigh", model: "claude-opus-5", session_id: null, short_id: null, worktree_path: null, branch: null, base_sha: null, process_state: "alive", process_generation: 1, turn_state: "idle", attach_state: "none", attached_by: null, paused: false, last_summary: null, last_step: null, question: null, parent_uuid: null, agent_id: null, agent_type: null, queued_at: null, qhead: false, started_at: 1, ended_at: null, created_at: 1, updated_at: 1, closed_at: null, usage_tokens: 0, summary_json: null, ...over }) as any;
const byId = (...ts: any[]) => Object.fromEntries(ts.map((t) => [t.uuid, t]));
const one = (m: any, tasks: any = {}, trail: any[] = []) => requestRows([m, ...trail], tasks)[0];

test("a needs_confirm request that was never resolved stays waiting for the user, with the reason and a redispatch", () => {
  const m = msg({ text: "어디에 던지면 좋을지 모르겠을때 물어보도록", dispatch_state: "needs_confirm", dispatch_json: { action: "route_to_task", task_id: "T-02", confidence: "low" } });
  const prompt = msg({ role: "system", dispatch_state: "direct", text: "Routing needs confirmation (confidence=low, candidate: route_to_task T-02). Which task? T-02 relay cli / T-03 freee-mcp" });
  const r = one(m, {}, [prompt]);
  expect(r).toMatchObject({ disposition: "needs_confirm", dispositionLabel: "Waiting for your confirmation", state: "Waiting for you", st: "wait", bucket: "needs_you", answerKind: "question", actions: ["redispatch"] });
  expect(r.answer).toContain("Which task?");
  // no confirmation prompt in the snapshot (older than the last 200 messages): the recorded candidate still says why it stalled
  expect(one(m).answer).toBe("Routing needs confirmation — candidate: route_to_task T-02");
  expect(one(msg({ dispatch_state: "needs_confirm" })).answer).toBe("Routing needs confirmation.");
});

test("a request routed into a task that is now in error surfaces the failure and offers the restart", () => {
  const t = task("u2", "T-02", "error", { last_summary: null });
  const m = msg({ text: "모든 작업이 완료되면 자동 종료되는 기능", task_uuid: "u2", dispatch_json: { action: "route_to_task", task_id: "T-02", confidence: "high" } });
  const err = msg({ role: "error", dispatch_state: "direct", task_uuid: "u2", text: "✖ T-02 relay cli — Session ended (other) — use Restart to --resume" });
  const r = one(m, byId(t), [err]);
  expect(r).toMatchObject({ disposition: "routed", dispositionLabel: "Routed into T-02", taskId: "T-02", taskStatus: "error", state: "Error", st: "err", bucket: "needs_you", answerKind: "error", actions: ["restart"] });
  expect(r.answer).toContain("Session ended");
  expect(one(m, byId(task("u2", "T-02", "error", { last_summary: "hit an unrecoverable auth error" }))).answer).toBe("hit an unrecoverable auth error");
});

test("a fast-path status query is answered by the row that follows it", () => {
  const m = msg({ text: "지금 뭐 돌아가?", dispatch_state: "fastpath" });
  const ans = msg({ role: "dispatcher_answer", dispatch_state: "direct", text: "Running 2 · Queued 0 · Needs input 1" });
  expect(one(m, {}, [ans])).toMatchObject({ disposition: "fastpath", dispositionLabel: "Answered from the status fast path", state: "Answered", st: "done", bucket: "settled", answer: "Running 2 · Queued 0 · Needs input 1", answerKind: "answer", actions: [] });
});

test("a direct dispatcher answer is read off the recorded decision, not off the chat rows", () => {
  const m = msg({ text: "relay 는 지금 몇 버전이야?", dispatch_json: { action: "answer_directly", answer: "0.1.1", confidence: "high" } });
  expect(one(m)).toMatchObject({ disposition: "answered", dispositionLabel: "Answered by the dispatcher", state: "Answered", bucket: "settled", answer: "0.1.1", answerKind: "answer" });
  // decision recorded without the answer text (older rows): the promoted dispatcher_answer row is the fallback
  expect(one(msg({ dispatch_json: { action: "answer_directly", confidence: "high" } }), {}, [msg({ role: "dispatcher_answer", dispatch_state: "direct", text: "0.1.1" })]).answer).toBe("0.1.1");
});

test("a completed task's summary is the answer to the request that started it", () => {
  const t = task("u1", "T-01", "done", { last_summary: "Updated freee-mcp to 1.4.0; bun test passes.", ended_at: 9 });
  const m = msg({ text: "freee mcp 를 최신으로 갱신해줘", task_uuid: "u1", dispatch_json: { action: "new_task", project: "freee-mcp", title: "update", confidence: "high" } });
  expect(one(m, byId(t))).toMatchObject({ disposition: "new_task", dispositionLabel: "Started T-01", state: "Done", st: "done", bucket: "settled", answer: "Updated freee-mcp to 1.4.0; bun test passes.", answerKind: "summary", actions: [] });
});

test("a running task is in flight; a waiting task hands back its question and an answer action", () => {
  const run = task("u3", "T-03", "running");
  const wait = task("u4", "T-04", "waiting_input", { question: { text: "Which project?", options: ["myapp", "relay"], asked_at: 1, source: "marker" } });
  expect(one(msg({ task_uuid: "u3", dispatch_json: { action: "new_task", confidence: "high" } }), byId(run))).toMatchObject({ state: "Running", st: "run", bucket: "in_flight", answer: null, actions: [] });
  expect(one(msg({ task_uuid: "u4", dispatch_json: { action: "new_task", confidence: "high" } }), byId(wait))).toMatchObject({ state: "Needs input", bucket: "needs_you", answer: "Which project?", answerKind: "question", actions: ["answer"] });
});

test("dispatch failure keeps the error and the retry; an undecided request is still in flight", () => {
  expect(one(msg({ dispatch_state: "failed", dispatch_error: "timeout" }))).toMatchObject({ disposition: "failed", dispositionLabel: "Dispatch failed", state: "Failed", st: "err", bucket: "needs_you", answer: "timeout", answerKind: "error", actions: ["redispatch"] });
  for (const st of ["pending", "deciding"]) expect(one(msg({ dispatch_state: st }))).toMatchObject({ disposition: "deciding", state: "Deciding", bucket: "in_flight", actions: [] });
});

test("a reply aimed at a task, a close request, and a task archived out of the snapshot", () => {
  const t = task("u1", "T-01", "done");
  expect(one(msg({ dispatch_state: "direct", task_uuid: "u1", reply_to_task_uuid: "u1" }), byId(t))).toMatchObject({ disposition: "delivered", dispositionLabel: "Sent to T-01", bucket: "settled" });
  expect(one(msg({ task_uuid: "u1", dispatch_json: { action: "close_task", task_id: "T-01", confidence: "high" } }), byId(t))).toMatchObject({ disposition: "close_request", dispositionLabel: "Close T-01 requested", bucket: "needs_you", actions: ["close"] });
  // the task closed long ago and no longer ships in the snapshot — the row must still say where the request went
  expect(one(msg({ task_uuid: "gone", dispatch_json: { action: "new_task", confidence: "high" } }))).toMatchObject({ disposition: "new_task", dispositionLabel: "Started a task", state: "Archived", st: "closed", bucket: "settled", taskId: null });
});

test("the stranded requests come first, then the in-flight ones, newest first inside each tier", () => {
  const tasks = byId(task("u1", "T-01", "done", { last_summary: "ok" }), task("u2", "T-02", "error"), task("u3", "T-03", "running"));
  const rows = requestRows([
    msg({ id: "a", created_at: 1, text: "freee mcp 를 최신으로 갱신해줘", task_uuid: "u1", dispatch_json: { action: "new_task", confidence: "high" } }),
    msg({ id: "b", created_at: 2, text: "relay 의 cli 버전도 tui 로", task_uuid: "u2", dispatch_json: { action: "new_task", confidence: "high" } }),
    msg({ id: "c", created_at: 3, text: "freee-mcp 에 추가로 개발할 요소가 잇을까?", task_uuid: "u3", dispatch_json: { action: "new_task", confidence: "high" } }),
    msg({ id: "d", created_at: 4, text: "모든 작업이 완료되면 자동 종료되는 기능", task_uuid: "u2", dispatch_json: { action: "route_to_task", task_id: "T-02", confidence: "high" } }),
    msg({ id: "e", created_at: 5, text: "프롬프트가 입력될때 goal 기능이", dispatch_state: "needs_confirm" }),
    msg({ id: "f", created_at: 6, text: "myapp refactor auth", dispatch_state: "needs_confirm" }),
    msg({ id: "g", created_at: 7, role: "system", dispatch_state: "direct", text: "▶ [myapp] started" }),
  ], tasks);
  expect(rows.map((r) => r.id)).toEqual(["f", "e", "d", "b", "c", "a"]);   // needs_you (newest first), then in_flight, then settled
  expect(rows.map((r) => r.bucket)).toEqual(["needs_you", "needs_you", "needs_you", "needs_you", "in_flight", "settled"]);
  expect(needsYou(rows)).toBe(4);
  expect(rows).toHaveLength(6);                                            // the system row is not a request
});
