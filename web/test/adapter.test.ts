import { expect, test } from "bun:test";
import { badgeParts, closeConfirmUuid, dlogEntry, eventLine, toDemoTask } from "../src/adapter.ts";
const base = (uuid: string, status: any, extra: Record<string, unknown> = {}) => ({ uuid, num: 3, display_id: "T-03", project_id: "p", title: "인증 리팩토링", status, size: "normal", effort: "xhigh", model: "claude-opus-5", session_id: "s", short_id: "ab12", worktree_path: "/w", branch: "relay-abc", base_sha: null, process_state: "alive", process_generation: 2, turn_state: "busy", attach_state: "none", attached_by: null, paused: false, last_summary: null, last_step: "Edit src/auth.ts", question: null, parent_uuid: null, agent_id: null, agent_type: null, queued_at: null, qhead: false, started_at: 1000, ended_at: null, created_at: 900, updated_at: 1, closed_at: null, usage_tokens: 0, summary_json: null, ...extra }) as any;
const ctx = { projects: [{ id: "p", name: "myapp" }] as any, tasks: {} as any };
test("toDemoTask maps status/label/step/question/children into the demo shape", () => {
  const parent = base("u1", "waiting_input", { question: { text: "어느 파일?", options: ["a.txt", "b.txt"], asked_at: 1, source: "marker" } }); const child = base("u2", "running", { display_id: "T-03.1", parent_uuid: "u1", agent_type: "relay-explore", num: -3001 });
  const tasks = { u1: parent, u2: child };
  const d = toDemoTask(parent, { ...ctx, tasks }); expect(d).toMatchObject({ id: "T-03", uuid: "u1", project: "myapp", status: "wait", statusLabel: "응답 대기", question: { q: "어느 파일?", chips: ["a.txt", "b.txt"] }, children: ["T-03.1"], sub: false, sid: "ab12", branch: "relay-abc" });
  expect(d.startedAt).toBeInstanceOf(Date); expect(d.step).toBe("Edit src/auth.ts");
  const c = toDemoTask(child, { ...ctx, tasks }); expect(c).toMatchObject({ id: "T-03.1", sub: true, parent: "T-03", status: "run", agentType: "relay-explore" });
  expect(toDemoTask(base("u3", "needs_review", { last_summary: "테스트 실패" }), ctx)).toMatchObject({ status: "wait", statusLabel: "검토 필요", step: "테스트 실패" });
  expect(toDemoTask(base("u4", "queued", { started_at: null, queued_at: 7, qhead: true }), ctx)).toMatchObject({ status: "queue", queuedAt: 7, qhead: true, startedAt: null });
});
test("badgeParts follows dispatch_state; dlogEntry mirrors the demo's rail; closeConfirmUuid parses the server's close prompt", () => {
  const m = (st: string, extra: Record<string, unknown> = {}) => ({ id: "m1", role: "user", source: "user", client_message_id: "c", dispatch_state: st, text: "auth 리팩토링", task_uuid: null, reply_to_task_uuid: null, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: 1, ...extra }) as any;
  const tasks = { u1: base("u1", "running") }; const c = { ...ctx, tasks };
  expect(badgeParts(m("pending"), c)).toMatchObject({ kind: "gateway", parts: ["⏳ 접수"], judging: false });
  expect(badgeParts(m("deciding"), c)).toMatchObject({ parts: ["● 판단 중 (fable)"], judging: true });
  expect(badgeParts(m("dispatched", { task_uuid: "u1", dispatch_json: { action: "new_task", size: "normal", project: "myapp" } }), c)).toMatchObject({ kind: "dispatcher", parts: ["new_task", "normal", "myapp"], task: { id: "T-03" } });
  expect(badgeParts(m("fastpath"), c)).toMatchObject({ kind: "gateway", parts: ["fast-path"] });
  expect(badgeParts(m("failed", { dispatch_error: "timeout" }), c)).toMatchObject({ parts: ["failed · timeout"], retry: true });
  expect(badgeParts(m("direct", { task_uuid: "u1" }), c)).toMatchObject({ kind: "↪ 답장", task: { id: "T-03" } });
  expect(dlogEntry(m("deciding"), c)).toMatchObject({ messageId: "m1", status: "judging" });
  expect(dlogEntry(m("dispatched", { task_uuid: "u1", dispatch_json: { action: "route_to_task" } }), c)).toMatchObject({ status: "done", result: { action: "route_to_task", ids: ["T-03"] } });
  expect(dlogEntry(m("failed", { dispatch_error: "timeout" }), c).result).toMatchObject({ action: "failed", note: "timeout" });
  expect(closeConfirmUuid("T-03 auth을(를) 종료할까요? [종료 확인: POST /api/tasks/3f2a-uuid/close]")).toBe("3f2a-uuid"); expect(closeConfirmUuid("hello")).toBeNull();
});
test("eventLine summarises hook events and stringifies payloads for the demo's <details><pre>", () => {
  const e = eventLine({ seq: 7, event_id: "e", type: "hook.PostToolUse", task_uuid: "u", payload: { tool_name: "Bash", tool_response: "ok" }, occurred_at: 1_700_000_000_000, recorded_at: 1, truncated: false } as any);
  expect(e).toMatchObject({ id: 7, txt: "PostToolUse · Bash" }); expect(e.at).toBeInstanceOf(Date); expect(e.payload).toContain('"tool_name"');
  expect(eventLine({ seq: 8, event_id: "f", type: "send.outcome", task_uuid: "u", payload: { outcome: "accepted", via: "socket" }, occurred_at: 1, recorded_at: 1, truncated: false } as any).txt).toBe("전달 accepted (socket)");
});
