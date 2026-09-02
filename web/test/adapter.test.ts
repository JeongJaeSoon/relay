import { expect, test } from "bun:test";
import { badgeParts, closeConfirmUuid, createNotifQueue, eventLine, isDispatcherBadgeRow, isTimelineEvent, promotedQuestionTask, toDemoForeign, toDemoTask } from "../src/adapter.ts";
import { store } from "../src/store.ts";
const base = (uuid: string, status: any, extra: Record<string, unknown> = {}) => ({ uuid, num: 3, display_id: "T-03", project_id: "p", title: "인증 리팩토링", status, size: "normal", effort: "xhigh", model: "claude-opus-5", session_id: "s", short_id: "ab12", worktree_path: "/w", branch: "relay-abc", base_sha: null, process_state: "alive", process_generation: 2, turn_state: "busy", attach_state: "none", attached_by: null, paused: false, last_summary: null, last_step: "Edit src/auth.ts", question: null, parent_uuid: null, agent_id: null, agent_type: null, queued_at: null, qhead: false, started_at: 1000, ended_at: null, created_at: 900, updated_at: 1, closed_at: null, usage_tokens: 0, summary_json: null, ...extra }) as any;
const ctx = { projects: [{ id: "p", name: "myapp" }] as any, tasks: {} as any };
test("toDemoTask maps status/label/step/question/children into the demo shape", () => {
  const parent = base("u1", "waiting_input", { question: { text: "어느 파일?", options: ["a.txt", "b.txt"], asked_at: 1, source: "marker" } }); const child = base("u2", "running", { display_id: "T-03.1", parent_uuid: "u1", agent_type: "relay-explore", num: -3001 });
  const tasks = { u1: parent, u2: child };
  const d = toDemoTask(parent, { ...ctx, tasks }); expect(d).toMatchObject({ id: "T-03", uuid: "u1", project: "myapp", status: "wait", statusLabel: "Needs input", question: { q: "어느 파일?", chips: ["a.txt", "b.txt"] }, children: ["T-03.1"], sub: false, sid: "ab12", branch: "relay-abc" });
  expect(d.startedAt).toBeInstanceOf(Date); expect(d.step).toBe("Edit src/auth.ts");
  const c = toDemoTask(child, { ...ctx, tasks }); expect(c).toMatchObject({ id: "T-03.1", sub: true, parent: "T-03", status: "run", agentType: "relay-explore" });
  expect(toDemoTask(base("u3", "needs_review", { last_summary: "테스트 실패" }), ctx)).toMatchObject({ status: "wait", statusLabel: "Needs review", step: "테스트 실패" });
  expect(toDemoTask(base("u4", "queued", { started_at: null, queued_at: 7, qhead: true }), ctx)).toMatchObject({ status: "queue", queuedAt: 7, qhead: true, startedAt: null });
});
test("badgeParts follows dispatch_state; closeConfirmUuid parses the server's close prompt", () => {
  const m = (st: string, extra: Record<string, unknown> = {}) => ({ id: "m1", role: "user", source: "user", client_message_id: "c", dispatch_state: st, text: "auth 리팩토링", task_uuid: null, reply_to_task_uuid: null, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: 1, ...extra }) as any;
  const tasks = { u1: base("u1", "running") }; const c = { ...ctx, tasks };
  expect(badgeParts(m("pending"), c)).toMatchObject({ kind: "gateway", parts: ["⏳ Accepted"], judging: false });
  expect(badgeParts(m("deciding"), c)).toMatchObject({ parts: ["● Deciding (fable)"], judging: true });
  expect(badgeParts(m("dispatched", { task_uuid: "u1", dispatch_json: { action: "new_task", size: "normal", project: "myapp" } }), c)).toMatchObject({ kind: "dispatcher", parts: ["new_task", "normal", "myapp"], task: { id: "T-03" } });
  expect(badgeParts(m("fastpath"), c)).toMatchObject({ kind: "gateway", parts: ["fast-path"] });
  expect(badgeParts(m("failed", { dispatch_error: "timeout" }), c)).toMatchObject({ parts: ["failed · timeout"], retry: true });
  expect(badgeParts(m("direct", { task_uuid: "u1" }), c)).toMatchObject({ kind: "↪ Reply", task: { id: "T-03" } });
  expect(badgeParts(m("dispatched", { task_uuid: "u1", dispatch_json: { action: "split", task_ids: ["T-03", "T-04"] } }), c)).toMatchObject({ kind: "dispatcher", parts: ["split", "2", "T-03 T-04"] });
  expect(closeConfirmUuid("Close T-03 auth? [close confirm: POST /api/tasks/3f2a-uuid/close]")).toBe("3f2a-uuid"); expect(closeConfirmUuid("hello")).toBeNull();
});
test("eventLine summarises hook events and stringifies payloads for the demo's <details><pre>", () => {
  const e = eventLine({ seq: 7, event_id: "e", type: "hook.PostToolUse", task_uuid: "u", payload: { tool_name: "Bash", tool_response: "ok" }, occurred_at: 1_700_000_000_000, recorded_at: 1, truncated: false } as any);
  expect(e).toMatchObject({ id: 7, txt: "PostToolUse · Bash" }); expect(e.at).toBeInstanceOf(Date); expect(e.payload).toContain('"tool_name"');
  expect(eventLine({ seq: 8, event_id: "f", type: "send.outcome", task_uuid: "u", payload: { outcome: "accepted", via: "socket" }, occurred_at: 1, recorded_at: 1, truncated: false } as any).txt).toBe("delivery accepted (socket)");
});

// --- regression: a hidden tab pauses rAF, so notifications must not be decided by the renderer ---
test("transitions between two renders still notify: running → done → running queues the done notification", () => {
  const q = createNotifQueue();
  q.observe(base("u1", "running")); q.observe(base("u1", "done", { last_summary: "ok", ended_at: 2 })); q.observe(base("u1", "running"));
  expect(q.drain().ops).toEqual([{ op: "add", taskUuid: "u1", kind: "done", title: "인증 리팩토링", body: "ok" }]);
  expect(q.drain().ops).toEqual([]);                                            // drained once
});
test("through the store: frames applied back to back with no render in between keep every transition", () => {
  store.reset(); const q = createNotifQueue();
  store.subscribe((f) => { if (f && (f.type === "task.created" || f.type === "task.updated")) q.observe(f.task); });   // the adapter's subscriber, without the rAF
  store.applyFrame({ seq: 1, idx: 0, type: "task.created", task: base("u1", "running") });
  store.applyFrame({ seq: 2, idx: 0, type: "task.updated", task: base("u1", "waiting_input", { question: { text: "a?", options: [], asked_at: 1, source: "marker" } }) });
  store.applyFrame({ seq: 3, idx: 0, type: "task.updated", task: base("u1", "done", { last_summary: "끝", ended_at: 3 }) });
  const { ops, chips } = q.drain();
  expect(ops).toEqual([
    { op: "add", taskUuid: "u1", kind: "wait", title: "인증 리팩토링", body: "a?" },   // task.created never notifies; the transition off it does
    { op: "withdraw", taskUuid: "u1", kind: "wait" },
    { op: "add", taskUuid: "u1", kind: "done", title: "인증 리팩토링", body: "끝" },
  ]);
  expect(chips).toEqual(["u1"]);                                                // the answered question greys its chat chips out on the next render
});

// --- QA (2026-08-31, live FakeRunner server): the server says some things twice, and says a lot we must not show ---
test("the dispatcher's decision is not drawn twice: the badge-chip row wins over the server's system text row", () => {
  const sys = (text: string) => ({ id: "s1", role: "system", source: "user", client_message_id: null, dispatch_state: "direct", text, task_uuid: null, reply_to_task_uuid: null, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: 1 }) as any;
  expect(isDispatcherBadgeRow(sys("dispatcher · new_task · normal · myapp"))).toBe(true);
  expect(isDispatcherBadgeRow(sys("dispatcher · route_to_task · T-01"))).toBe(true);
  expect(isDispatcherBadgeRow(sys("▶ [myapp] auth refactor started (T-01)"))).toBe(false);                       // the started row stays
  expect(isDispatcherBadgeRow(sys("Close T-01 auth? [close confirm: POST /api/tasks/u1/close]"))).toBe(false);   // so does the close prompt
  expect(isDispatcherBadgeRow({ ...sys("dispatcher · x"), role: "user" })).toBe(false);                    // only the server's own system rows
});
test("the timeline shows the worker's observations, not relay's bookkeeping", () => {
  for (const t of ["hook.PreToolUse", "hook.PostToolUse", "hook.Stop", "hook.verdict", "hook.SubagentStart", "send.outcome", "message.sent"]) expect(isTimelineEvent(t)).toBe(true);
  // one live task ran up 119 task.patched rows against 110 hook events; the detail fetch adds command/permit/process churn on top
  for (const t of ["task.patched", "task.status_changed", "task.created", "command.queued", "command.running", "command.applied", "permit.acquired", "permit.released", "permit.rebound", "process.started", "process.ended", "message.received", "question.answered", "usage.sampled"]) expect(isTimelineEvent(t)).toBe(false);
});

// --- sessions relay did not start: shown, never managed ---
test("toDemoForeign names a session by what is knowable, in that order: roster name, directory, session id", () => {
  const f = (o: Record<string, unknown> = {}) => ({ session_id: "3f2a9b1c-dead-beef-0000-000000000001", short_id: "zz01", name: null, cwd: "/Users/me/code/other-repo/", busy: true, pid: 9001, started_at: 1_700_000_000_000, kind: "bg", first_seen: 10, last_seen: 20, ...o }) as any;
  expect(toDemoForeign(f({ name: "  notes cleanup  " }))).toMatchObject({ title: "notes cleanup", state: "running", stateLabel: "Running", kind: "background", short: "zz01", cwd: "/Users/me/code/other-repo" });
  expect(toDemoForeign(f()).title).toBe("other-repo");                                              // no name → the directory it was launched in
  expect(toDemoForeign(f({ name: "", cwd: null })).title).toBe("session 3f2a9b1c");                 // nothing at all → the identity itself
  expect(toDemoForeign(f({ name: "", cwd: null })).cwd).toBe("—");
  expect(toDemoForeign(f({ busy: false })).stateLabel).toBe("Idle");
  expect(toDemoForeign(f({ busy: null })).stateLabel).toBe("Unknown");                              // the roster reports no status for some rows
  expect(toDemoForeign(f({ short_id: null })).short).toBe("—");
  const d = toDemoForeign(f()); expect(d.key).toBe(d.sid); expect(d.startedAt).toBeInstanceOf(Date); expect(d.firstSeen.getTime()).toBe(10);
  expect(toDemoForeign(f({ started_at: null })).startedAt).toBeNull();                              // the session registry may not have the entry
});

// A promoted `question` chat row outlives the question: it stays in the snapshot after the task answers, but
// toDemoTask only fills `question` while the task is waiting. chatQuestion reads t.question.q, so on any reload
// whose last 200 messages contain an answered question, syncMessages threw and aborted the whole sync() — blank
// canvas, no graph, no sidebar. The guard makes the row fall through to the plain chat row, which already
// carries the question text. #24 fixed this and its own second commit undid it (the test below only pinned
// toDemoTask, not the branch), so the branch is now a function this test calls directly.
test("a question row whose task has moved on does not take the render down with it", () => {
  const row = { role: "question" } as any;
  const waiting = toDemoTask(base("u1", "waiting_input", { question: { text: "a?", options: ["x"], asked_at: 1, source: "marker" } }), ctx) as any;
  const answered = toDemoTask(base("u1", "running", { question: null }), ctx) as any;
  expect(answered.question).toBeNull();
  expect(promotedQuestionTask(row, waiting)).toBe(waiting);                     // still waiting: the chips row
  expect(promotedQuestionTask(row, answered)).toBeNull();                       // moved on: fall through to the plain row — this is the dereference that threw
  expect(promotedQuestionTask(row, undefined)).toBeNull();                      // task gone from the snapshot
  expect(promotedQuestionTask({ role: "system" } as any, waiting)).toBeNull();  // only the promoted question row draws chips
});
