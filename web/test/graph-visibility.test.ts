import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const visibility = app.slice(app.indexOf("function graphTaskVisible(t){"), app.indexOf("/* ================= chat ================= */"));
const render = app.slice(app.indexOf("function renderNodes(){"), app.indexOf("/* ---- sessions outside relay:"));
const boxes = app.slice(app.indexOf("function graphBoxes(){"), app.indexOf("function fit(){"));
const minimap = app.slice(app.indexOf("function updateMinimap(){"), app.indexOf("function mmJump(e){"));

test("child graph visibility follows its parent while preserving task history", () => {
  for (const parentStatus of ["run", "done", "err", "closed", "queue", "missing"]) {
    const parent = { id: "T-01", status: parentStatus, children: ["T-01.1"] };
    const child = { id: "T-01.1", status: "done", sub: true, parent: parent.id };
    const tasks = new Map([[child.id, child], ...(parentStatus === "missing" ? [] : [[parent.id, parent] as const])]);
    const context: any = { S: { tasks }, tasksArr: () => [...tasks.values()] };
    runInNewContext(visibility + "result=graphTasks().map(t=>t.id);", context);
    expect(context.result.includes(child.id)).toBe(!["closed", "queue", "missing"].includes(parentStatus));
    expect(tasks.get(child.id)).toBe(child);
    expect(child.status).toBe("done");
    if (parentStatus === "queue") expect(context.result).toEqual([parent.id]);
  }
});

test("archive or missing-parent snapshot removes stale DOM and leaves an empty graph, fit and minimap", () => {
  for (const missing of [false, true]) {
    const parent = { id: "T-01", status: "closed" };
    const child = { id: "T-01.1", status: "done", sub: true, parent: parent.id };
    const tasks = new Map([[child.id, child], ...(missing ? [] : [[parent.id, parent] as const])]);
    const nodes = new Map([parent, child].map(t => ["node-" + t.id, { id: "node-" + t.id, remove() { nodes.delete(this.id); } }]));
    const hint = { style: {}, offsetLeft: 32, offsetTop: 106, offsetWidth: 224, offsetHeight: 80 };
    const mmEl = { style: {}, textContent: "stale markers" };
    const context: any = { S: { tasks, foreign: new Map(), sel: null, paused: false }, tasksArr: () => [...tasks.values()], foreignArr: () => [],
      famOf: () => new Set(), canvas: { classList: { toggle() {} }, clientWidth: 800 },
      nodesBox: { querySelectorAll: () => [...nodes.values()] }, document: { getElementById: (id: string) => nodes.get(id) },
      renderForeignNodes() {}, $: () => hint, gwEl: { offsetLeft: 32, offsetTop: 32, offsetWidth: 210, offsetHeight: 54 }, mmEl };
    runInNewContext(visibility + render + boxes + minimap + "renderNodes(); result=graphBoxes(); empty=emptyHintBox(); updateMinimap();", context);
    expect(nodes.size).toBe(0);
    expect(context.result.map((b: any) => b.st)).toEqual(["gw"]);
    expect(hint.style).toMatchObject({ display: "flex" });
    expect(context.empty).not.toBeNull();
    expect(mmEl.style).toMatchObject({ display: "none" });
    expect(mmEl.textContent).toBe("");
    expect(tasks.get(child.id)).toBe(child);
  }
});
