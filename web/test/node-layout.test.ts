import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const visibility = app.slice(app.indexOf("function graphTaskVisible(t){"), app.indexOf("/* ================= chat ================= */"));
const dimensions = app.slice(app.indexOf("const ROW_H="), app.indexOf("const S="));
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
  for (let q = 0; q < 3; q++) {
    const queued = { id: `Q-${q}`, status: "queue", children: [], sub: false };
    tasks.push(queued); heights.set(`node-${queued.id}`, 90 + q * 15);
  }
  const foreign: any[] = [107, 143, 118].map((h, i) => { heights.set(`fnode-f${i}`, h); return { key: `f${i}` }; });
  runInNewContext(dimensions + visibility + code + "\nlayout();", {
    S: { layout: mode, tasks: new Map(tasks.map(t => [t.id, t])) },
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
      const column = tasks.filter(t => t.sub === sub && t.status !== "queue").sort((a, b) => a.y - b.y);
      for (let i = 1; i < column.length; i++) {
        expect(column[i].y - column[i - 1].y - heights.get(`node-${column[i - 1].id}`)!).toBeGreaterThanOrEqual(18);
      }
    }
  }
});

test("wider task columns and variable-height queue cards leave clear gaps", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const widths = {
    parent: Number(html.match(/\.node\{\s*position:absolute;width:(\d+)px/)![1]),
    child: Number(html.match(/\.node\.sub\{width:(\d+)px/)![1]),
    queue: Number(html.match(/\.node\.queued\{width:(\d+)px/)![1]),
  };
  for (const mode of ["tree", "radial"]) {
    const { tasks, foreign, heights } = arrange(mode);
    const parent = tasks.find(t => !t.sub && t.status === "run"), child = tasks.find(t => t.sub);
    expect(child.x - parent.x - widths.parent).toBeGreaterThanOrEqual(60);
    expect(foreign[0].x - child.x - widths.child).toBeGreaterThanOrEqual(60);
    const queue = tasks.filter(t => t.status === "queue");
    expect(parent.x - queue[0].x - widths.queue).toBeGreaterThanOrEqual(60);
    for (let i = 1; i < queue.length; i++) {
      expect(queue[i].y - queue[i - 1].y - heights.get(`node-${queue[i - 1].id}`)!).toBeGreaterThanOrEqual(18);
    }
  }
});
