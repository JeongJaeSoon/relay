import { beforeEach, describe, expect, test } from "bun:test";
import { store } from "../src/store.ts";
const task = (uuid: string, status: any, extra: Record<string, unknown> = {}) => ({ uuid, num: 1, display_id: "T-01", project_id: "p", title: "t", status, size: "normal", effort: "xhigh", model: "m", session_id: null, short_id: null, worktree_path: null, branch: null, base_sha: null, process_state: "none", process_generation: 0, turn_state: "idle", attach_state: "none", attached_by: null, paused: false, last_summary: null, last_step: null, question: null, parent_uuid: null, agent_id: null, agent_type: null, queued_at: null, qhead: false, started_at: null, ended_at: null, created_at: 1, updated_at: 1, closed_at: null, usage_tokens: 0, summary_json: null, ...extra }) as any;
describe("store.applyFrame", () => {
  beforeEach(() => store.reset());
  test("hello keeps the cursor; older/duplicate (seq, idx) frames are ignored while the next idx of the same seq applies", () => {
    store.applyFrame({ seq: 10, idx: 0, type: "hello", as_of_seq: 10, state: {} as any }); expect(store.state.seq).toBe(0);      // hello never moves the cursor
    store.applyFrame({ seq: 9, idx: 0, type: "task.created", task: task("a", "queued") }); expect(store.state.seq).toBe(9);
    store.applyFrame({ seq: 9, idx: 0, type: "task.created", task: task("dup", "queued") }); expect(store.state.tasks.dup).toBeUndefined();   // duplicate (seq, idx) ignored
    store.applyFrame({ seq: 9, idx: 1, type: "task.created", task: task("b2", "queued") }); expect(store.state.tasks.b2).toBeDefined(); expect(store.state.idx).toBe(1);   // same event, next frame — must apply
    store.applyFrame({ seq: 8, idx: 5, type: "task.created", task: task("old", "queued") }); expect(store.state.tasks.old).toBeUndefined();
  });
  test("snapshot sets the cursor to (as_of_seq, MAX) so frames of that seq are dropped and later ones apply", () => {
    store.applySnapshot({ as_of_seq: 5, tasks: [task("s", "running")], projects: [], state: { paused: false } as any, messages: [] });
    store.applyFrame({ seq: 5, idx: 0, type: "task.created", task: task("x", "queued") }); expect(store.state.tasks.x).toBeUndefined();
    store.applyFrame({ seq: 6, idx: 0, type: "task.created", task: task("y", "queued") }); expect(store.state.tasks.y).toBeDefined();
  });
  test("messages upsert by id and stay sorted; events capped at 200; dirty sets accumulate and drain resets them", () => {
    const m = (id: string, at: number, st = "pending") => ({ id, role: "user", source: "user", client_message_id: id, dispatch_state: st, text: "x", task_uuid: null, reply_to_task_uuid: null, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: at }) as any;
    store.applyFrame({ seq: 1, idx: 0, type: "chat.message", message: m("b", 2) }); store.applyFrame({ seq: 2, idx: 0, type: "chat.message", message: m("a", 1) }); store.applyFrame({ seq: 3, idx: 0, type: "dispatch.updated", message: m("b", 2, "dispatched") });
    expect(store.state.messages.map((x) => x.id + ":" + x.dispatch_state)).toEqual(["a:pending", "b:dispatched"]);
    store.applyFrame({ seq: 4, idx: 0, type: "task.created", task: task("t", "running") });
    for (let i = 0; i < 250; i++) store.applyFrame({ seq: 5 + i, idx: 0, type: "task.event", task_uuid: "t", event: { seq: 5 + i, event_id: String(i), type: "hook.PostToolUse", task_uuid: "t", payload: {}, occurred_at: 1, recorded_at: 1, truncated: false } as any });
    expect(store.state.events.t.length).toBe(200);
    const d = store.drain(); expect([...d.tasks]).toEqual(["t"]); expect([...d.messages].sort()).toEqual(["a", "b"]); expect([...d.events]).toEqual(["t"]);
    expect(store.drain().tasks.size).toBe(0);
  });
  test("subscribers fire once per applied frame, not for dropped ones", () => {
    let n = 0; const off = store.subscribe(() => n++);
    store.applyFrame({ seq: 1, idx: 0, type: "system.state", state: { paused: true } as any }); store.applyFrame({ seq: 1, idx: 0, type: "system.state", state: { paused: true } as any });
    expect(n).toBe(1); expect(store.state.sys?.paused).toBe(true); off();
  });
});
