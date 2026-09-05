import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const visibility = app.slice(app.indexOf("function graphTaskVisible(t){"), app.indexOf("/* ================= chat ================= */"));
const code = app.slice(app.indexOf("function layout(){"), app.indexOf("function nodeEl(t){"));
function arrange(mode: string) {
  const tasks: any[] = [];
  const heights = new Map<string, number>();
  for (let p = 0; p < 3; p++) {
    const parent = { id: `T-${p}`, status: "run", children: [] as string[], sub: false };
    tasks.push(parent); heights.set(`node-${parent.id}`, 107);
    for (let c = 0; c < 4; c++) {
      const id = `${parent.id}.${c}`; parent.children.push(id);
      tasks.push({ id, parent: parent.id, status: "run", children: [], sub: true }); heights.set(`node-${id}`, 90 + c * 13);
    }
  }
  const foreign: any[] = [107, 143, 118].map((h, i) => { heights.set(`fnode-f${i}`, h); return { key: `f${i}` }; });
  runInNewContext(visibility + code + "\nlayout();", {
    S: { layout: mode, tasks: new Map(tasks.map(t => [t.id, t])) },
    ROW_Y0: 40, ROW_H: 128, SUB_ROW: 102, COL_TASK: 312, COL_SUB: 596, COL_FOREIGN: 900, NODE_GAP: 18,
    tasksArr: () => tasks, foreignArr: () => foreign, queueOrder: () => 0, renderNodes() {},
    gwEl: { style: {}, offsetHeight: 54 },
    document: { getElementById: (id: string) => ({ offsetHeight: heights.get(id), style: {} }) },
  });
  return { tasks, foreign, heights };
}

test("outside cards keep a visible gap even when their rendered heights differ", () => {
  for (const mode of ["tree", "radial"]) {
    const { foreign, heights } = arrange(mode);
    for (let i = 1; i < foreign.length; i++) {
      expect(foreign[i].y - foreign[i - 1].y - heights.get(`fnode-${foreign[i - 1].key}`)!).toBeGreaterThanOrEqual(18);
    }
  }
});

test("three parents with four children each do not overlap within either task column", () => {
  for (const mode of ["tree", "radial"]) {
    const { tasks, heights } = arrange(mode);
    for (const sub of [false, true]) {
      const column = tasks.filter(t => t.sub === sub).sort((a, b) => a.y - b.y);
      for (let i = 1; i < column.length; i++) {
        expect(column[i].y - column[i - 1].y - heights.get(`node-${column[i - 1].id}`)!).toBeGreaterThanOrEqual(18);
      }
    }
  }
});
