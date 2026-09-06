import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createStore } from "../src/store.ts";
import { stKey, stLabel } from "../src/consts.ts";
import { requestRows } from "../src/ledger.ts";
import { currentMessages, currentRequestRows } from "../src/conversation-scope.ts";
import { diffNotifs } from "../src/notify.ts";
import { chatFor } from "../../src/core/promote.ts";
import { stripAsk } from "../../shared/ask.ts";

// Run the actual complete adapter in an isolated browser-shaped realm. Each test owns its
// store/subscriber/rAF queue, so installing the adapter cannot leak into another test file.
const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
  readFileSync(new URL("../src/adapter.ts", import.meta.url), "utf8")
).replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
class Node {
  children: Node[] = [];
  parent: Node | null = null;
  dataset: Record<string, string> = {};
  constructor(public tag: string, public className = "", public textContent = "") {}
  append(...nodes: Node[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceWith(node: Node) { const parent = this.parent!; parent.children[parent.children.indexOf(this)] = node; node.parent = parent; }
  addEventListener() {}
  replaceChildren(...nodes: Node[]) { this.children = []; this.append(...nodes); }
}
const task = (extra: Record<string, unknown> = {}) => ({
  uuid: "agent-uuid", display_id: "T-01", num: 1, project_id: "p", title: "Agent one", status: "running", size: "normal", effort: "high", model: "claude-opus", process_state: "alive", process_generation: 1, turn_state: "busy", attach_state: "none", question: null, created_at: 1, ...extra,
}) as any;
const message = (id: string, role: string, text: string, extra: Record<string, unknown> = {}) => ({
  id, role, text, source: "user", task_uuid: "agent-uuid", reply_to_task_uuid: null, dispatch_state: "direct", dispatch_json: null, created_at: Number(id.replace(/\D/g, "")) || 1, ...extra,
}) as any;
function setup(saved?: string) {
  const store = createStore(); const frames: (() => void)[] = []; const calls: string[] = [];
  const storage = new Map(saved ? [["relay-selected-task", saved]] : []);
  const msgs = new Node("div"); const S = { tasks: new Map(), foreign: new Map(), sel: null as string | null, fsel: null as string | null };
  const context: any = {
    store, stKey, stLabel, requestRows, currentMessages, currentRequestRows, diffNotifs, stripAsk,
    api: { createMessageSender: () => async () => {}, taskDetail: async () => { calls.push("loadDetail"); return { events: [] }; } },
    S, msgs, LEDGER: [], location: { port: "18814" },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length; },
    document: { querySelectorAll: () => [] },
    gwEl: { classList: { toggle() {}, contains: () => false }, querySelector: () => ({ textContent: "" }) },
    el: (tag: string, cls = "", text = "") => new Node(tag, cls, text),
    ttagBtn: (t: any) => new Node("button", "ttag", t.id),
    chatDaySeparator: (at: number) => calls.push(`day:${at}`),
    chatUser: (text: string, at?: number) => { calls.push(`user:${at ?? ""}`); msgs.append(new Node("div", "m-user", text)); },
    chatMsg: (t: any, text: string, at?: number) => {
      calls.push(`message:${at ?? ""}`);
      const row = new Node("div", "m-row", text);
      row.dataset.sender = t ? t.title : "Relay";
      if (t) { row.dataset.agent = t.uuid; row.dataset.history = String(!!t.history); }
      msgs.append(row); return row;
    },
    chatQuestion: (t: any, at?: number) => { calls.push(`question:${at ?? ""}`); const row = new Node("div", "m-question", t.question.q); msgs.append(row); return row; },
    scrollChat: () => calls.push("scrollChat"),
    select: (id: string | null) => { calls.push("select"); S.sel = id; },
    clearSel() {}, selectForeign() {},
  };
  for (const name of ["refresh", "relayout", "renderBanner", "renderSettings", "renderSidebar", "renderLedger", "notify", "withdrawNotif"]) context[name] = () => calls.push(name);
  runInNewContext(source + "\ninstallAdapter();", context);
  const flush = () => { for (const frame of frames.splice(0)) frame(); };
  const snapshot = (messages: any[], tasks = [task()]) => { store.applySnapshot({ as_of_seq: 0, state: null, projects: [], tasks, messages } as any); flush(); };
  return { store, calls, storage, msgs, S, context, snapshot, flush };
}

test("message replay and dispatch updates preserve a single user bubble and its adjacent receipt", () => {
  const h = setup(); const user = message("m1", "user", "Please check", { dispatch_state: "pending" });
  const reply = message("m2", "worker_summary", "Checked");
  h.snapshot([user, reply]);
  expect(h.msgs.children.map(n => n.className)).toEqual(["m-user", "m-receipt", "m-row"]);
  const receipt = h.msgs.children[1]; const firstBadge = receipt.children[0];
  h.store.applyFrame({ type: "dispatch.updated", seq: 1, idx: 0, message: { ...user, dispatch_state: "direct" } }); h.flush();
  expect(h.msgs.children[1]).toBe(receipt);
  expect(receipt.children[0]).not.toBe(firstBadge);
  expect(receipt.children[0].children[0].textContent).toBe("↪ Reply");
  h.store.applyFrame({ type: "chat.message", seq: 2, idx: 0, message: reply }); h.flush();
  h.snapshot([user, reply]);
  expect(h.msgs.children.map(n => n.className)).toEqual(["m-user", "m-receipt", "m-row"]);
});

test("timestamps and local-day separators follow stored message order without replay duplicates", () => {
  const h = setup();
  const first = new Date(2026, 8, 6, 23, 58).getTime();
  const second = new Date(2026, 8, 7, 0, 2).getTime();
  const messages = [
    message("m1", "user", "First", { created_at: first }),
    message("m2", "worker_summary", "Second", { created_at: second }),
  ];
  h.snapshot(messages);
  expect(h.calls.filter(c => c.startsWith("day:"))).toEqual([`day:${first}`, `day:${second}`]);
  expect(h.calls).toContain(`user:${first}`);
  expect(h.calls).toContain(`message:${second}`);
  h.store.applyFrame({ type: "chat.message", seq: 1, idx: 0, message: messages[1] }); h.flush();
  h.snapshot(messages);
  expect(h.calls.filter(c => c.startsWith("day:"))).toEqual([`day:${first}`, `day:${second}`]);
  expect(h.msgs.children.map(n => n.className)).toEqual(["m-user", "m-receipt", "m-row"]);
});

test("system rows are Relay, while task-bound agent output keeps its sender and history navigation identity", () => {
  const h = setup(); const historical = "unknown-historical-agent";
  h.snapshot([
    message("m1", "system", "Relay routed this", { task_uuid: "agent-uuid", created_at: 10 }),
    message("m2", "worker_summary", "Agent result", { task_uuid: "agent-uuid", created_at: 11 }),
    message("m3", "system", "Older relay notice", { task_uuid: historical, created_at: 12 }),
    message("m4", "worker_summary", "Older result", { task_uuid: historical, created_at: 13 }),
  ]);
  const rows = h.msgs.children.filter(n => n.className === "m-row");
  expect(rows.map(n => n.dataset.sender)).toEqual(["Relay", "Agent one"]);
  expect(rows[1].dataset.agent).toBe("agent-uuid");
  h.context.setConversationHistory(true);
  const historyRows = h.msgs.children.filter(n => n.className === "m-row");
  expect(historyRows.map(n => n.dataset.sender)).toEqual(["Relay", "Agent one", "Relay", "Historical session"]);
  expect(historyRows[3].dataset.agent).toBe(historical);
});

test("a task-bound dispatcher answer remains Relay rather than borrowing the agent identity", () => {
  const h = setup();
  h.snapshot([message("m1", "dispatcher_answer", "Relay status answer", { task_uuid: "agent-uuid", created_at: 10 })]);
  const row = h.msgs.children.find(n => n.className === "m-row")!;
  expect(row.dataset.sender).toBe("Relay");
  expect(row.dataset.agent).toBeUndefined();
});

test("restoring a saved UUID restores selection once without opening detail or taking focus", () => {
  const h = setup("agent-uuid"); h.snapshot([]);
  expect(h.S.sel).toBe("T-01");
  expect(h.calls).not.toContain("select");
  expect(h.calls).not.toContain("loadDetail");
  h.S.sel = null; h.snapshot([]);
  expect(h.S.sel).toBeNull(); // reconnect must not resurrect the previous choice
});

test("a missing saved UUID is retired, while explicit selection persists UUID and loads detail", () => {
  const h = setup("removed-agent"); h.snapshot([]);
  expect(h.storage.has("relay-selected-task")).toBe(false);
  h.context.select("T-01");
  expect(h.storage.get("relay-selected-task")).toBe("agent-uuid");
  expect(h.calls).toContain("loadDetail");
});

test("historical questions retain their own text when a later question is currently open", () => {
  const h = setup();
  h.snapshot([message("m1", "question", "Old question?", { created_at: 10 }), message("m2", "question", "Current question?", { created_at: 20 })],
    [task({ status: "waiting_input", question: { text: "Current question?", options: ["Yes"], asked_at: 20, source: "marker" } })]);
  expect(h.msgs.children.map(n => n.textContent)).toEqual(["Old question?", "Current question?"]);
  expect(h.msgs.children.filter(n => n.className === "m-question")).toHaveLength(1);
});


test("server-promoted question labels/options work, but a previous identical occurrence stays historical", () => {
  const h = setup();
  const current = task({ status: "waiting_input", question: { text: "Allow?", options: ["Allow", "Deny"], asked_at: 30, source: "permission" } });
  const promoted = chatFor("question", current, "Allow? (Allow / Deny)");
  h.snapshot([{ ...promoted, id: "m1", created_at: 10 }, { ...promoted, id: "m2", created_at: 31 }], [current]);
  expect(h.msgs.children.map(n => n.textContent)).toEqual([promoted.text, "Allow?"]);
  expect(h.msgs.children.filter(n => n.className === "m-question")).toHaveLength(1);
});


test("retained messages from a removed task preserve historical UUID identity through request navigation", () => {
  const h = setup();
  const uuid = "archived-agent-uuid";
  h.snapshot([
    message("m1", "user", "Review old output", { task_uuid: uuid }),
    message("m2", "worker_summary", "Old output reviewed", { task_uuid: uuid }),
    message("m3", "question", "Historical question?", { task_uuid: uuid }),
    message("m4", "system", "System notice", { task_uuid: null }),
  ], []);
  expect(h.msgs.children.some(n => n.dataset.agent === uuid)).toBe(false);
  expect(h.context.LEDGER).toHaveLength(0);
  h.context.setConversationHistory(true);
  const [summary, question, system] = h.msgs.children.filter(n => n.className === "m-row");
  expect(summary.dataset).toEqual({ sender: "Historical session", agent: uuid, history: "true" });
  expect(question.dataset.agent).toBe(uuid);
  expect(question.textContent).toBe("Historical question?");
  expect(system.dataset).toEqual({ sender: "Relay" });
  expect(h.context.LEDGER[0].taskUuids).toEqual([uuid]);
  expect(h.context.LEDGER[0].taskIds).toEqual([]);
  expect(h.S.tasks.size).toBe(0); // no phantom manageable task
});


test("closing a task hides its messages and requests immediately; History restores read-only records", () => {
  const h = setup();
  h.snapshot([message("m1", "user", "Check"), message("m2", "question", "Continue?")], [task({ status: "done" })]);
  expect(h.context.LEDGER).toHaveLength(1);
  expect(h.msgs.children.some(n => n.textContent === "Continue?")).toBe(true);
  h.store.applyFrame({ type: "task.updated", seq: 1, idx: 0, task: task({status: "closed"}) }); h.flush();
  expect(h.context.LEDGER).toHaveLength(0);
  expect(h.msgs.children.some(n => n.textContent === "Continue?")).toBe(false);
  h.context.setConversationHistory(true);
  expect(h.msgs.children.some(n => n.textContent === "Continue?")).toBe(true);
  expect(h.context.LEDGER[0]).toMatchObject({state: "Archived", bucket: "settled", actions: []});
  h.context.setConversationHistory(false);
  expect(h.context.LEDGER).toHaveLength(0);
});
