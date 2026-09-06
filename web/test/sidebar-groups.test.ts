import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const code = app.slice(app.indexOf("const GROUPS=["), app.indexOf("/* ================= detail"));
class Element {
  children: Element[] = []; parent: Element | null = null;
  dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
  handlers: Record<string, () => void> = {}; id = ""; type = ""; hidden = false; scrollTop = 0;
  private text: string;
  constructor(public tag: string, public className = "", text = "") { this.text = text; }
  get textContent() { return this.text; }
  set textContent(text: string) { this.text = text; this.children = []; }
  append(...children: Element[]) { children.forEach(child => { child.parent = this; this.children.push(child); }); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, fn: () => void) { this.handlers[name] = fn; }
  matches(selector: string) { return selector.startsWith(".") ? this.className.split(" ").includes(selector.slice(1)) : this.tag === selector; }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap(c => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
}
function setup(saved: string | null = null, denied = false) {
  const sidebar = new Element("nav"); sidebar.id = "sidebar";
  let stored = saved; let focus: any = null;
  const marks: any[] = [];
  const c: any = { S: { sel: null, fsel: null }, tasks: [], foreign: [], savedFocus: null,
    $: (selector: string) => selector === "#sidebar" ? sidebar : null,
    localStorage: { getItem: () => { if (denied) throw new Error("denied"); return stored; }, setItem: (_key: string, value: string) => { if (denied) throw new Error("denied"); stored = value; } },
    el: (tag: string, cls = "", text = "") => new Element(tag, cls || "", text),
    captureFocus: () => c.savedFocus, restoreFocus: (value: any) => focus = value,
    famOf: () => new Set(), tasksArr: () => c.tasks, foreignArr: () => c.foreign,
    taskStateLabel: (t: any) => t.status, elapsedText: () => "01:00", agentMark: (agent: any) => { marks.push(agent); return new Element("span", "agent-mark"); }, stateBadge: () => new Element("span"),
    locationLabel: () => new Element("div"), directoryName: (s: string) => s, foreignDirectory: (f: any) => f.cwd,
  };
  runInNewContext(app.slice(app.indexOf("function foreignStateClass("), app.indexOf("function foreignElapsed(")) + code, c);
  const group = (id: string) => sidebar.children.find(n => n.children[1].id === "sidebar-group-" + id)!;
  return { c, sidebar, group, marks, stored: () => stored, focus: () => focus };
}
const task = (status = "run") => ({ id: "T-01", title: "Task", status, project: "project" });

test("sidebar groups merge retained Claude sessions into their status groups", () => {
  const { c, sidebar, group } = setup();
  c.tasks = [task("run"), task("done")];
  c.foreign = [
    { key: "run", sid: "session-run", short: "run", title: "Running session", state: "running", stateLabel: "Running", cwd: "synthetic" },
    { key: "idle", sid: "session-idle", short: "idle", title: "Idle session", state: "idle", stateLabel: "Idle", cwd: "synthetic" },
    { key: "done", sid: "session-done", short: "done", title: "Done session", state: "done", stateLabel: "Done", cwd: "synthetic" },
    { key: "stopped", sid: "session-stopped", short: "stopped", title: "Stopped session", state: "stopped", stateLabel: "Stopped", cwd: "synthetic" },
    { key: "failed", sid: "session-failed", short: "failed", title: "Failed session", state: "failed", stateLabel: "Error", cwd: "synthetic" },
  ]; c.renderSidebar();
  expect(sidebar.children).toHaveLength(5);
  for (const [id, cls, count] of [["attention", "st-wait", "1"], ["running", "st-run", "2"], ["queued", "st-queue", "0"], ["idle", "st-queue", "1"], ["done", "st-done", "3"]]) {
    const [header, body] = group(id).children;
    expect(header.tag).toBe("button"); expect(header.type).toBe("button");
    expect(header.className).toContain(cls); expect(header.dataset.focusKey).toBe("group:" + id);
    expect(header.attributes).toMatchObject({ "aria-expanded": "true", "aria-controls": body.id });
    expect(header.querySelector(".cnt")!.textContent).toBe(count); expect(body.hidden).toBe(false);
  }
  expect(sidebar.querySelector(".group-label")!.textContent).not.toBe("Claude sessions");
});

test("folds persist across selected-task updates and reload while counts and focus keys remain visible", () => {
  const h = setup(); h.c.tasks = [task()]; h.c.S.sel = "T-01"; h.c.renderSidebar();
  h.sidebar.scrollTop = 95; h.group("running").children[0].handlers.click();
  expect(h.group("running").children[1].hidden).toBe(true); expect(h.sidebar.scrollTop).toBe(95);
  h.c.savedFocus = { key: "group:running", root: "sidebar" };
  h.c.tasks.push({ ...task(), id: "T-02" }); h.c.renderSidebar();
  expect(h.group("running").children[1].hidden).toBe(true);
  expect(h.group("running").children[0].querySelector(".cnt")!.textContent).toBe("2"); expect(h.focus().key).toBe("group:running");
  const reload = setup(h.stored()); reload.c.tasks = h.c.tasks; reload.c.renderSidebar();
  expect(reload.group("running").children[0].attributes["aria-expanded"]).toBe("false");
  reload.group("running").children[0].handlers.click(); expect(JSON.parse(reload.stored()!).running).toBe(false);
});

test("a focused task moving into a folded group restores its header instead of a hidden row", () => {
  const h = setup(JSON.stringify({ done: true })); h.c.tasks = [task()]; h.c.renderSidebar();
  h.c.savedFocus = { node: h.group("running").querySelector(".s-item"), root: "sidebar", key: "task:T-01" };
  h.c.tasks[0].status = "done"; h.c.renderSidebar();
  expect(h.focus().node).toBe(h.group("done").children[0]); expect(h.focus().key).toBe("group:done");
  expect(h.group("done").children[1].hidden).toBe(true);
});

test("Idle appears only for retained idle sessions and keeps its fold when they return", () => {
  const h = setup(); const session = { key: "idle-one", sid: "session-uuid", short: "idle-1", title: "Other", state: "idle", stateLabel: "Idle", cwd: "synthetic" };
  h.c.foreign = [session]; h.c.renderSidebar(); h.group("idle").children[0].handlers.click();
  h.c.foreign = []; h.c.renderSidebar(); expect(h.group("idle")).toBeUndefined();
  h.c.foreign = [session]; h.c.renderSidebar(); expect(h.group("idle").children[1].hidden).toBe(true);
  expect(h.marks).toContainEqual({ uuid: "session-uuid", id: "idle-1" });
});

test("archived tasks do not inflate Done", () => {
  const h = setup(); h.c.tasks = [task("closed")]; h.c.renderSidebar();
  expect(h.group("done").children[0].querySelector(".cnt")!.textContent).toBe("0");
});

test("a selected retained session stays selected in its unified status group", () => {
  const h = setup(); h.c.S.fsel = "retained-done";
  h.c.foreign = [{ key: "retained-done", sid: "session-uuid", short: "done-1", title: "Finished", state: "done", stateLabel: "Done", cwd: "synthetic" }];
  h.c.renderSidebar();
  const row = h.group("done").querySelector(".s-item")!;
  expect(row.dataset.focusKey).toBe("foreign:retained-done");
  expect(row.attributes["aria-current"]).toBe("true");
  expect(row.className).toContain("sel");
});

test("invalid or unavailable storage defaults to expanded groups and rejects nonboolean preferences", () => {
  for (const value of ["{broken", "null", "[]", '"false"', '{"running":"true","done":1}']) {
    const h = setup(value); h.c.renderSidebar(); expect(h.sidebar.children.every(n => !n.children[1].hidden)).toBe(true);
  }
  const h = setup(null, true); h.c.renderSidebar(); expect(() => h.group("queued").children[0].handlers.click()).not.toThrow();
  expect(h.group("queued").children[1].hidden).toBe(true);
});
