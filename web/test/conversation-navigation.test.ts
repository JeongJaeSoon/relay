import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const identity = app.slice(app.indexOf("function agentKey("), app.indexOf("function agentMark("));
const jump = app.slice(app.indexOf("function jumpToRequest("), app.indexOf("/* ================= request ledger"));

test("agent identity follows UUID across status, title and display ID changes", () => {
  const c: any = {};
  runInNewContext(identity, c);
  const original = { uuid: "agent-a", id: "T-01", status: "run" };
  expect(c.agentIdentity(original)).toEqual(c.agentIdentity({ ...original, id: "T-20", status: "done", title: "new" }));
  const identities = Array.from({ length: 12 }, (_, i) => JSON.stringify(c.agentIdentity({ uuid: `agent-${i}` })));
  expect(new Set(identities).size).toBeGreaterThan(6);
  expect(c.agentIdentity(original)).toEqual(c.agentIdentity({ uuid: "agent-a", id: "T-01", history: true }));
  expect(c.agentIdentity(original).symbol).toMatch(/\p{Extended_Pictographic}/u);
  const refreshed: any = {};
  runInNewContext(identity, refreshed);
  expect(refreshed.agentIdentity(original)).toEqual(c.agentIdentity(original));
});

test("sender avatar and task ID form one named pill, including retained historical senders", () => {
  class Node {
    children: Node[] = []; attrs: Record<string,string> = {}; style = { setProperty() {} };
    constructor(public tag: string, public cls: string, public text = "") {}
    append(...items: Node[]) { this.children.push(...items); }
    setAttribute(key: string, value: string) { this.attrs[key] = value; }
    addEventListener() {}
  }
  const c: any = { el: (tag: string, cls: string, text?: string) => new Node(tag, cls, text) };
  const renderers = app.slice(app.indexOf("function agentKey("), app.indexOf("function chatMsg("));
  runInNewContext(renderers, c);
  const task = { uuid: "agent-a", id: "T-01", title: "Review export" };
  const sender = c.messageSender(task);
  expect(sender.text).toBe("");
  expect(sender.children).toHaveLength(1);
  const pill = sender.children[0];
  expect(pill.attrs["aria-label"]).toBe("T-01 · Review export");
  expect(pill.children[1].text).toBe("T-01");
  expect(pill.children[0].attrs["aria-hidden"]).toBe("true");
  const historical = c.messageSender({ ...task, history: true }).children[0];
  expect(historical.tag).toBe("span");
  expect(historical.children[0].text).toBe(pill.children[0].text);
});

function navigation() {
  const messages: any[] = [], timers: (() => void)[] = [];
  let focused: any = null;
  const status: any = { hidden: true, textContent: "", focus() { focused = status; } };
  const panes: string[] = [];
  const context: any = { RZ: { ch: true, dt: false }, S: { tasks: new Map([ ["T-01", { id: "T-01", uuid: "new-generation" }], ["T-02", { id: "T-02", uuid: "second" }] ]) },
    followChat: true, $: () => status, showChatPane: (p: string) => panes.push(p), setTimeout: (f: () => void) => timers.push(f),
    msgs: { querySelectorAll: (selector: string) => selector === ".m-row" ? messages : messages.filter(m => m.highlighted) } };
  function message(agent: string, taskId: string) {
    const n: any = { dataset: { agent, taskId }, highlighted: false, scrolled: false,
      classList: { add() { n.highlighted = true; }, remove() { n.highlighted = false; } },
      focus() { focused = n; }, scrollIntoView() { n.scrolled = true; } };
    messages.push(n);return n;
  }
  runInNewContext(identity + jump, context);
  return { context, status, panes, message, timers, focused: () => focused };
}

test("request navigation finds the newest matching agent, ignores reused display IDs, and leaves detail closed", () => {
  const c = navigation();
  c.message("new-generation", "T-01");
  const latest = c.message("new-generation", "T-01");
  c.message("old-generation", "T-01");
  c.message("second", "T-02");
  c.context.jumpToRequest({ taskIds: ["T-01"] });
  expect(c.focused()).toBe(latest);expect(latest.scrolled).toBe(true);expect(latest.highlighted).toBe(true);
  expect(c.context.followChat).toBe(false);expect(c.context.RZ.dt).toBe(false);
  expect(c.panes).toEqual(["messages"]);
  c.timers.forEach(f => f());expect(latest.highlighted).toBe(false);
});

test("split request chips target their own agent, and missing history gives an accessible empty result", () => {
  const c = navigation();
  const first = c.message("new-generation", "T-01");
  c.message("second", "T-02");
  c.context.jumpToRequest({ taskIds: ["T-01", "T-02"] }, "T-01");
  expect(c.focused()).toBe(first);
  c.context.jumpToRequest({ taskIds: ["T-99"] });
  expect(c.status.hidden).toBe(false);expect(c.focused()).toBe(c.status);
  expect(first.highlighted).toBe(false);
});

test("incoming messages do not pull a reader away from earlier history", () => {
  const listeners: Record<string, () => void> = {};
  const msgs = { scrollTop: 0, scrollHeight: 1000, clientHeight: 300, addEventListener: (name: string, fn: () => void) => listeners[name] = fn };
  const code = app.slice(app.indexOf("let followChat="), app.indexOf("function chatUser("));
  const context: any = { msgs };runInNewContext(code, context);
  msgs.scrollTop = 200;listeners.scroll();msgs.scrollHeight = 1200;context.scrollChat();
  expect(msgs.scrollTop).toBe(200);
  context.scrollChat(true);expect(msgs.scrollTop).toBe(1200);
});

test("retained messages remain reachable by UUID after their task leaves the snapshot", () => {
  const c = navigation();
  const past = c.message("retained-history", "retained");
  c.context.jumpToRequest({ taskIds: [], taskUuids: ["retained-history"] });
  expect(c.focused()).toBe(past);expect(past.highlighted).toBe(true);
});
