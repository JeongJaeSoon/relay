import { expect, test } from "bun:test";
import { needsYou, requestRows } from "../src/ledger.ts";

let seq = 0;
const msg = (over: Record<string, unknown> = {}) => ({ id: `m${++seq}`, role: "user", source: "user", client_message_id: null, dispatch_state: "dispatched", text: "", task_uuid: null, reply_to_task_uuid: null, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: seq * 1000, ...over }) as any;
const task = (uuid: string, display_id: string, status: string, over: Record<string, unknown> = {}) => ({ uuid, num: Number(display_id.slice(2)), display_id, project_id: "p", title: "t", status, size: "normal", effort: "xhigh", model: "claude-opus-5", session_id: null, short_id: null, worktree_path: null, branch: null, base_sha: null, process_state: "alive", process_generation: 1, turn_state: "idle", attach_state: "none", attached_by: null, paused: false, last_summary: null, last_step: null, question: null, parent_uuid: null, agent_id: null, agent_type: null, queued_at: null, qhead: false, started_at: 1, ended_at: null, created_at: 1, updated_at: 1, closed_at: null, usage_tokens: 0, summary_json: null, ...over }) as any;
const byId = (...ts: any[]) => Object.fromEntries(ts.map((t) => [t.uuid, t]));
const one = (m: any, tasks: any = {}, trail: any[] = []) => requestRows([m, ...trail], tasks)[0];

test("a needs_confirm request that was never resolved stays waiting for the user, with the reason and a redispatch", () => {
  const m = msg({ text: "어디에 던지면 좋을지 모르겠을때 물어보도록", dispatch_state: "needs_confirm", dispatch_json: { action: "route_to_task", task_id: "T-02", confidence: "low" } });
  // routing into an errored task emits the decision's badge row first — the prompt after it is the one that says why this stalled
  const badge = msg({ role: "system", dispatch_state: "direct", text: "dispatcher · route_to_task · T-02" });
  const prompt = msg({ role: "system", dispatch_state: "direct", text: "Routing needs confirmation (confidence=low, candidate: route_to_task T-02). Which task? T-02 relay cli / T-03 freee-mcp" });
  const r = one(m, {}, [badge, prompt]);
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
  // the task closed long ago and no longer ships in the snapshot — the row must still say where the request went,
  // and a uuid the tasks map does not know can never become an action target
  expect(one(msg({ task_uuid: "gone", dispatch_json: { action: "new_task", confidence: "high" } }))).toMatchObject({ disposition: "new_task", dispositionLabel: "Started a task", state: "Archived", st: "closed", bucket: "settled", taskId: null, actions: [] });
});

// A session relay did not start lives in store.foreign, never in store.tasks, and no message ever requested it. The
// ledger is a fold over user messages, so it cannot invent a row for one — and an id the tasks map lacks yields no action.
test("sessions relay only watches produce no ledger row and no action target", () => {
  const foreignId = "4b49b9fc-2784-4322-8c08-2fb4b2a59316";
  const rows = requestRows([msg({ text: "myapp refactor auth", task_uuid: "u1", dispatch_json: { action: "new_task", confidence: "high" } })], byId(task("u1", "T-01", "running")));
  expect(rows).toHaveLength(1);
  expect(rows.every((r) => r.taskUuid !== foreignId)).toBe(true);
  const stray = one(msg({ dispatch_state: "direct", task_uuid: foreignId }));   // even were a session id to reach a message, it resolves to no task
  expect(stray).toMatchObject({ taskId: null, taskStatus: null, actions: [] });
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

// A split makes several tasks but `messages.task_uuid` holds only the first (C.4.4), so reading the row off that one
// alone named one task out of three and hid the state of the other two — including a piece stranded on a question.
test("a split names every task it made, and its state is the piece that most needs reading", () => {
  const ids = ["T-01", "T-02", "T-03"];
  const m = msg({ text: "TUI 설계랑 라이프사이클 정리 같이", task_uuid: "u1", dispatch_json: { action: "split", task_ids: ids } });
  const tasks = byId(task("u1", "T-01", "running"), task("u2", "T-02", "waiting_input", { question: { text: "which file?", options: [], asked_at: 1, source: "marker" } }), task("u3", "T-03", "done"));
  const r = one(m, tasks);
  expect(r).toMatchObject({ disposition: "split", dispositionLabel: "Split into separate tasks", taskIds: ids });
  expect(r).toMatchObject({ taskId: "T-02", state: "Needs input", bucket: "needs_you", actions: ["answer"] });   // not T-01, which task_uuid points at
  expect(r.answer).toBe("which file?");
  // nothing waiting: the running piece decides, and the row stays in flight rather than settling on the done one
  const running = one(m, byId(task("u1", "T-01", "done"), task("u2", "T-02", "running"), task("u3", "T-03", "done")));
  expect(running).toMatchObject({ taskId: "T-02", bucket: "in_flight", taskIds: ids });
  // every piece finished
  expect(one(m, byId(task("u1", "T-01", "done"), task("u2", "T-02", "done"), task("u3", "T-03", "done")))).toMatchObject({ bucket: "settled" });
});

// The dispatcher decides one message at a time (Dispatcher.enqueue) but a message is recorded the moment it arrives,
// so a second request sent while the first is still deciding is recorded BEFORE the first request's reply. Reading
// the trail as "everything up to the next request" therefore showed the newer row the older request's reason — the
// default with two requests in flight, and exactly the pile-up this view exists to make legible.
test("two requests in flight: each needs_confirm row shows its own reason, not the one before it", () => {
  // arrival order: A, B, then A's decision (badge + prompt), then B's
  const A = msg({ id: "A", text: "T-01 에 이어서 해줘", dispatch_state: "needs_confirm", dispatch_json: { action: "route_to_task", task_id: "T-01", confidence: "high" } });
  const B = msg({ id: "B", text: "myapp 인증 리팩토링", dispatch_state: "needs_confirm", dispatch_json: { action: "route_to_task", task_id: "T-07", confidence: "high" } });
  const sys = (text: string) => msg({ role: "system", dispatch_state: "direct", text });
  const rows = requestRows([A, B,
    sys("dispatcher · route_to_task · T-01"), sys("Routing needs confirmation (task T-01 not found, candidate: route_to_task T-01). Which task? T-05 relay / T-06 myapp"),
    sys("dispatcher · route_to_task · T-07"), sys("Routing needs confirmation (task T-07 not found, candidate: route_to_task T-07). Which task? T-05 relay / T-06 myapp"),
  ], {});
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  expect(by.A.answer).toContain("task T-01 not found");
  expect(by.B.answer).toContain("task T-07 not found");
  expect(by.A.bucket).toBe("needs_you");
  expect(by.B.bucket).toBe("needs_you");
});

test("two status queries in a row: each gets its own answer, not the other's", () => {
  const s1 = msg({ id: "s1", text: "지금 뭐 돌아가?", dispatch_state: "fastpath" });
  const s2 = msg({ id: "s2", text: "상태 알려줘", dispatch_state: "fastpath" });
  const ans = (text: string) => msg({ role: "dispatcher_answer", dispatch_state: "direct", text });
  const by = Object.fromEntries(requestRows([s1, s2, ans("Running 2 · Queued 0"), ans("Running 3 · Queued 1")], {}).map((r) => [r.id, r]));
  expect(by.s1.answer).toBe("Running 2 · Queued 0");
  expect(by.s2.answer).toBe("Running 3 · Queued 1");
});

// A direct answer records its text in the decision AND emits the chat row. The row still has to be consumed, or it is
// left over and claimed by the next request that has only the row to read.
test("an answer already in the decision still consumes its chat row", () => {
  const a = msg({ id: "a", text: "relay 는 지금 몇 버전이야?", dispatch_json: { action: "answer_directly", answer: "0.1.2", confidence: "high" } });
  const b = msg({ id: "b", text: "지금 뭐 돌아가?", dispatch_state: "fastpath" });
  const ans = (text: string) => msg({ role: "dispatcher_answer", dispatch_state: "direct", text });
  const by = Object.fromEntries(requestRows([a, b, msg({ role: "system", dispatch_state: "direct", text: "dispatcher · answer_directly" }), ans("0.1.2"), ans("Running 2 · Queued 0")], {}).map((r) => [r.id, r]));
  expect(by.a.answer).toBe("0.1.2");
  expect(by.b.answer).toBe("Running 2 · Queued 0");
});

// The cases that already worked, kept working: a row nobody is waiting for must not be claimed, and a request that
// awaits no dispatcher reply must not consume one.
test("a worker summary between two requests belongs to its task, and claims no reply", () => {
  const t = task("u1", "T-01", "done", { last_summary: null });
  const started = msg({ id: "a", text: "freee mcp 갱신", task_uuid: "u1", dispatch_json: { action: "new_task", confidence: "high" } });
  const summary = msg({ role: "worker_summary", dispatch_state: "direct", task_uuid: "u1", text: "Updated freee-mcp to 1.4.0." });
  const status = msg({ id: "b", text: "지금 뭐 돌아가?", dispatch_state: "fastpath" });
  const ans = msg({ role: "dispatcher_answer", dispatch_state: "direct", text: "Running 0 · Queued 0" });
  const by = Object.fromEntries(requestRows([started, summary, status, ans], byId(t)).map((r) => [r.id, r]));
  expect(by.a).toMatchObject({ answer: "Updated freee-mcp to 1.4.0.", answerKind: "summary" });
  expect(by.b.answer).toBe("Running 0 · Queued 0");
});

test("a route, a close request and an archived task claim nothing, so a later answer stays with its own request", () => {
  const err = task("u2", "T-02", "error");
  const closed = task("u3", "T-03", "closed");
  const routed = msg({ id: "a", task_uuid: "u2", dispatch_json: { action: "route_to_task", task_id: "T-02", confidence: "high" } });
  const archived = msg({ id: "b", task_uuid: "gone", dispatch_json: { action: "new_task", confidence: "high" } });
  const close = msg({ id: "c", task_uuid: "u3", dispatch_json: { action: "close_task", task_id: "T-03", confidence: "high" } });
  const noUuid = msg({ id: "d", dispatch_json: { action: "answer_directly", answer: "0.1.2", confidence: "high" } });
  const ans = msg({ role: "dispatcher_answer", dispatch_state: "direct", text: "0.1.2" });
  const by = Object.fromEntries(requestRows([routed, archived, close, noUuid, ans], byId(err, closed)).map((r) => [r.id, r]));
  expect(by.a).toMatchObject({ disposition: "routed", state: "Error", answerKind: "error" });
  expect(by.b).toMatchObject({ disposition: "new_task", state: "Archived", bucket: "settled", answer: null });
  expect(by.c).toMatchObject({ disposition: "close_request", bucket: "settled", actions: [] });
  expect(by.d).toMatchObject({ disposition: "answered", answer: "0.1.2" });
});

// `answer` renders the question's options as chips, and toDemoTask only fills question while the task is waiting, so a
// question resolved by another path left the row in needs_you labelled "Needs input" with no chips and nothing to click.
test("a waiting task whose question is gone offers no answer action", () => {
  const t = task("u1", "T-01", "waiting_input");
  const r = one(msg({ task_uuid: "u1", dispatch_json: { action: "new_task", confidence: "high" } }), byId(t));
  expect(r).toMatchObject({ state: "Needs input", answer: null, actions: [] });
});

// requestRows sorts by created_at, so the arrival order lives in the timestamps, not in the array order — these two
// cases differ only in when B was sent. Serialised was correct before the fix and has to stay correct.
test("serialised and overlapped arrivals both keep each reason on its own request", () => {
  const req = (id: string, at: number, text: string, tid: string) => msg({ id, created_at: at, text, dispatch_state: "needs_confirm", dispatch_json: { action: "route_to_task", task_id: tid, confidence: "high" } });
  const prm = (at: number, tid: string) => msg({ role: "system", dispatch_state: "direct", created_at: at, text: `Routing needs confirmation (task ${tid} not found, candidate: route_to_task ${tid}). Which task? T-05 relay` });
  const reasons = (ms: any[]) => Object.fromEntries(requestRows(ms, {}).map((r) => [r.id, r.answer]));

  // A is answered before B is even sent
  const serialised = reasons([req("A", 1000, "T-01 에 이어서", "T-01"), prm(2000, "T-01"), req("B", 3000, "myapp 인증", "T-09"), prm(4000, "T-09")]);
  expect(serialised.A).toContain("task T-01 not found");
  expect(serialised.B).toContain("task T-09 not found");

  // B is sent while A is still deciding — both rows were wrong before the fix: B took A's reason and A lost its own
  const overlapped = reasons([req("A", 1000, "T-01 에 이어서", "T-01"), req("B", 2000, "myapp 인증", "T-09"), prm(3000, "T-01"), prm(4000, "T-09")]);
  expect(overlapped.A).toContain("task T-01 not found");
  expect(overlapped.B).toContain("task T-09 not found");
  expect(overlapped.A).not.toBe("Routing needs confirmation — candidate: route_to_task T-01");   // the generic fallback the row degraded to
  expect(overlapped).toEqual(serialised);                                                        // the ordering must not change what a row says
});

// drainPending() re-queues every pending message at once (restart, POST /resume-all), so every request row precedes
// every reply row. No timing luck: with N outstanding, the last row took the first answer and the other N−1 degraded.
test("a drained backlog gives every request its own reply, in order", () => {
  const ids = ["r1", "r2", "r3"];
  const reqs = ids.map((id, i) => msg({ id, created_at: 1000 + i, text: `요청 ${i + 1}`, dispatch_state: "needs_confirm", dispatch_json: { action: "route_to_task", task_id: `T-0${i + 1}`, confidence: "high" } }));
  const prompts = ids.map((_, i) => msg({ role: "system", dispatch_state: "direct", created_at: 2000 + i, text: `Routing needs confirmation (task T-0${i + 1} not found). Which task? T-05 relay` }));
  const by = Object.fromEntries(requestRows([...reqs, ...prompts], {}).map((r) => [r.id, r]));
  for (const [i, id] of ids.entries()) expect(by[id].answer).toContain(`task T-0${i + 1} not found`);
  expect(needsYou(Object.values(by) as any)).toBe(3);
});

// The row names the piece lead() picked, but the outcome fallback was keyed on m.task_uuid — the FIRST piece of a
// split (C.4.4). onCrash sets the status to error and emits the reason as a chat row, leaving last_summary null, so
// the fallback is the live path for a failure: T-02's row printed T-01's success line as its failure reason, in red.
test("a split's failed piece answers with its own outcome, not the first piece's", () => {
  const m = msg({ text: "TUI 설계랑 라이프사이클 정리 같이", task_uuid: "u1", dispatch_json: { action: "split", task_ids: ["T-01", "T-02"], confidence: "high" } });
  const ok = msg({ role: "worker_summary", dispatch_state: "direct", task_uuid: "u1", text: "✔ T-01 TUI 설계 — done" });
  const bad = msg({ role: "error", dispatch_state: "direct", task_uuid: "u2", text: "✖ T-02 라이프사이클 — Session ended (other) — use Restart to --resume" });
  const tasks = byId(task("u1", "T-01", "done", { last_summary: null }), task("u2", "T-02", "error", { last_summary: null }));
  const r = one(m, tasks, [ok, bad]);
  // both halves: the row must name the failing piece AND answer with that piece's outcome — they broke apart
  expect(r).toMatchObject({ taskId: "T-02", state: "Error", st: "err", answerKind: "error" });
  expect(r.answer).toBe("✖ T-02 라이프사이클 — Session ended (other) — use Restart to --resume");
});

// Not every needs_confirm comes off the dispatcher chain. POST /api/messages with reply_to_task_id records the
// message as `direct` and calls TaskService.answer() synchronously in the same handler (routes.ts:61-62); if the
// target task is in the error state that runs through to needsConfirm(), so the prompt is written while chain
// requests are still inside `claude -p`. Feeding it to the shared FIFO is worse than the positional bug it replaces:
// one row degrading to its own candidate becomes every row confidently showing someone else's reason.
test("a reply to an errored task keeps its own reason and takes nothing from the chain", () => {
  const chain = (id: string, at: number, tid: string) => msg({ id, created_at: at, dispatch_state: "needs_confirm", dispatch_json: { action: "route_to_task", task_id: tid, confidence: "high" } });
  const sys = (at: number, text: string) => msg({ role: "system", dispatch_state: "direct", created_at: at, text });
  const reply = (id: string, at: number) => msg({ id, created_at: at, dispatch_state: "needs_confirm", task_uuid: "u9", reply_to_task_uuid: "u9" });
  const ERR = "Routing needs confirmation (T-09 is in the error state — restart it first). Which task? T-05 relay";
  const errored = byId(task("u9", "T-09", "error"));                // the snapshot carries every task that is not closed
  const rows = (ms: any[]) => Object.fromEntries(requestRows(ms, errored).map((r) => [r.id, r.answer]));

  const by = rows([chain("A", 1000, "T-01"), chain("B", 2000, "T-02"), chain("C", 3000, "T-03"), reply("M", 4000), sys(4001, ERR),
    sys(5000, "Routing needs confirmation (task T-01 not found, candidate: route_to_task T-01). Which task? T-05 relay"),
    sys(6000, "Routing needs confirmation (task T-02 not found, candidate: route_to_task T-02). Which task? T-05 relay"),
    sys(7000, "Routing needs confirmation (task T-03 not found, candidate: route_to_task T-03). Which task? T-05 relay")]);
  expect(by.M).toBe(ERR);                             // the off-chain row keeps its own reason …
  expect(by.A).toContain("task T-01 not found");      // … and the chain rows are untouched by it
  expect(by.B).toContain("task T-02 not found");
  expect(by.C).toContain("task T-03 not found");

  // ulid() is not monotonic and created_at is milliseconds, so the prompt can sort just ahead of its own message
  const tied = rows([chain("A", 1000, "T-01"), sys(4000, ERR), reply("zM", 4000),
    sys(5000, "Routing needs confirmation (task T-01 not found, candidate: route_to_task T-01). Which task? T-05 relay")]);
  expect(tied.zM).toBe(ERR);
  expect(tied.A).toContain("task T-01 not found");
});

test("a reply to an errored task, on its own, reads its reason and offers the restart", () => {
  const m = msg({ text: "그럼 이걸로 진행해줘", dispatch_state: "needs_confirm", task_uuid: "u9", reply_to_task_uuid: "u9" });
  const prompt = msg({ role: "system", dispatch_state: "direct", text: "Routing needs confirmation (T-09 is in the error state — restart it first). Which task? T-05 relay" });
  const r = one(m, byId(task("u9", "T-09", "error")), [prompt]);
  // the target is in error, so the row offers Restart alongside the redispatch
  expect(r).toMatchObject({ disposition: "needs_confirm", state: "Waiting for you", bucket: "needs_you", answerKind: "question", actions: ["redispatch", "restart"] });
  expect(r.answer).toContain("T-09 is in the error state");
});

// Adjacency cannot carry this: created_at is milliseconds and ulid() is not monotonic, so a chain prompt sharing the
// millisecond can sort ahead of the off-chain message or between it and its own prompt, and nothing tells them apart
// by position. Matching the prompt's text removes position from the question entirely. A miss is not neutral either —
// an unclaimed off-chain prompt flows into the shared pool and lands on a chain row, so H3 pins that too.
test("the off-chain prompt is found by its text, wherever it sorts", () => {
  const errored = byId(task("u9", "T-09", "error"));
  const M = (id: string, at: number) => msg({ id, created_at: at, dispatch_state: "needs_confirm", task_uuid: "u9", reply_to_task_uuid: "u9" });
  const A = (at: number) => msg({ id: "A", created_at: at, dispatch_state: "needs_confirm", dispatch_json: { action: "route_to_task", task_id: "T-01", confidence: "high" } });
  const sys = (id: string, at: number, text: string) => msg({ id, role: "system", dispatch_state: "direct", created_at: at, text });
  const pA = (id: string, at: number) => sys(id, at, "Routing needs confirmation (task T-01 not found, candidate: route_to_task T-01). Which task? T-05");
  const pM = (id: string, at: number) => sys(id, at, "Routing needs confirmation (T-09 is in the error state — restart it first). Which task? T-05");
  const ok = (ms: any[], mid: string) => {
    const by = Object.fromEntries(requestRows(ms, errored).map((r) => [r.id, r.answer]));
    expect(by[mid]).toContain("T-09 is in the error state");
    expect(by.A).toContain("task T-01 not found");
  };
  ok([A(1000), pA("a", 2000), M("b", 2000), pM("c", 2000)], "b");   // H1 chain prompt sorts before the message
  ok([A(1000), M("a", 2000), pA("b", 2000), pM("c", 2000)], "a");   // H2 chain prompt sorts between the two
  ok([A(1000), M("M", 2000), sys("x", 3000, "dispatcher · route_to_task · T-01"), pM("y", 4000), pA("z", 5000)], "M");   // H3 a badge sits between
});

// The target is always in the snapshot for this path — it is in the error state, and the snapshot carries every task
// that is not closed. If it somehow is not, the prompt cannot be named; retiring it unclaimed costs this row its
// reason, where leaving it in the pool would have put it on a chain row instead.
test("an unnameable off-chain prompt degrades its own row and no other", () => {
  const M = msg({ id: "M", created_at: 2000, dispatch_state: "needs_confirm", task_uuid: "gone", reply_to_task_uuid: "gone" });
  const A = msg({ id: "A", created_at: 1000, dispatch_state: "needs_confirm", dispatch_json: { action: "route_to_task", task_id: "T-01", confidence: "high" } });
  const sys = (at: number, text: string) => msg({ role: "system", dispatch_state: "direct", created_at: at, text });
  const by = Object.fromEntries(requestRows([A, M,
    sys(3000, "Routing needs confirmation (T-09 is in the error state — restart it first). Which task? T-05"),
    sys(4000, "Routing needs confirmation (task T-01 not found, candidate: route_to_task T-01). Which task? T-05")], {}).map((r) => [r.id, r.answer]));
  expect(by.M).toBe("Routing needs confirmation.");                 // degraded, not someone else's reason
  expect(by.A).toContain("task T-01 not found");                    // the chain row keeps its own
});

// A snapshot from a database written before the 0.1.1 English migration. Nothing here is malformed — only the prose
// changed — but matching the prompt on its English opening made every Korean row unrecognisable, and the two oldest
// requests then sat at the head of the claim queue and took the prompts belonging to the two newest. Both of those
// rows displayed a reason from a request they had nothing to do with, on the user's own data.
test("a pre-0.1.1 snapshot: every request keeps its own reason, in either language", () => {
  const NT = { action: "new_task", confidence: "low" };
  const ko = (id: string, at: number) => msg({ id, role: "system", dispatch_state: "direct", created_at: at, text: "라우팅 확인 필요 (confidence=low, 후보: new_task). 어느 작업인가요? T-02 relay / T-03 myapp" });
  const en = (id: string, at: number) => msg({ id, role: "system", dispatch_state: "direct", created_at: at, text: "Routing needs confirmation (T-02 is in the error state — restart it first). Which task? T-02 relay" });
  const by = Object.fromEntries(requestRows([
    msg({ id: "R1", created_at: 1000, text: "myapp refactor auth", dispatch_state: "needs_confirm", dispatch_json: NT }), ko("K1", 1100),
    msg({ id: "R2", created_at: 2000, text: "myapp task with a question", dispatch_state: "needs_confirm", dispatch_json: NT }), ko("K2", 2100),
    msg({ id: "R3", created_at: 3000, text: "아 그리고 프롬프트가 입력될때", dispatch_state: "needs_confirm" }),
    msg({ id: "R4", created_at: 4000, text: "어디에 던지면 좋을지 모르겠을때", dispatch_state: "needs_confirm" }),
    en("E1", 5000), en("E2", 6000),
  ], {}).map((r) => [r.id, r.answer]));
  expect(by.R1).toContain("라우팅 확인 필요");        // its own, unreadable to the old matcher
  expect(by.R2).toContain("라우팅 확인 필요");
  expect(by.R3).toContain("T-02 is in the error state");
  expect(by.R4).toContain("T-02 is in the error state");
});

// The property, independent of why a row went unmatched: a request that cannot be matched must not take a reply from
// a request after it. Here the two oldest simply have no prompt row at all — the same shape an unreadable prompt, an
// unknown future row, or a lost write would produce.
test("requests whose reply is missing degrade, and do not shift the requests after them", () => {
  const req = (id: string, at: number, tid: string) => msg({ id, created_at: at, dispatch_state: "needs_confirm", dispatch_json: { action: "route_to_task", task_id: tid, confidence: "high" } });
  const prm = (at: number, tid: string) => msg({ role: "system", dispatch_state: "direct", created_at: at, text: `Routing needs confirmation (task ${tid} not found). Which task? T-05` });
  const by = Object.fromEntries(requestRows([req("A", 1000, "T-01"), req("B", 2000, "T-02"), req("C", 3000, "T-03"), req("D", 4000, "T-04"), prm(5000, "T-03"), prm(6000, "T-04")], {}).map((r) => [r.id, r.answer]));
  expect(by.C).toContain("task T-03 not found");                        // the matchable ones are right …
  expect(by.D).toContain("task T-04 not found");
  expect(by.A).toBe("Routing needs confirmation — candidate: route_to_task T-01");   // … and the deficit degrades
  expect(by.B).toBe("Routing needs confirmation — candidate: route_to_task T-02");
});

// The surplus direction: a redispatch leaves the prompt from the previous attempt in the table, so there are more
// prompts than requests awaiting one. Pairing from the newest end takes the current prompt, not the stale one.
test("a stale prompt left by a redispatch is absorbed, and the row reads its newest one", () => {
  const by = Object.fromEntries(requestRows([
    msg({ id: "A", created_at: 1000, dispatch_state: "needs_confirm", dispatch_json: { action: "route_to_task", task_id: "T-01", confidence: "high" } }),
    msg({ role: "system", dispatch_state: "direct", created_at: 2000, text: "Routing needs confirmation (stale attempt). Which task? T-05" }),
    msg({ role: "system", dispatch_state: "direct", created_at: 3000, text: "Routing needs confirmation (task T-01 not found). Which task? T-05" }),
  ], {}).map((r) => [r.id, r.answer]));
  expect(by.A).toContain("task T-01 not found");
});
