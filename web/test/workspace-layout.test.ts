import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const dock = app.slice(app.indexOf("function dockHeight(){"), app.indexOf("function applySizes(){"));
function height(viewport: number, saved: number | null, banner = 0) {
  const context: any = { RZ: { chh: saved }, document: { documentElement: { clientHeight: viewport } },
    $: () => ({ offsetHeight: banner }), clampNum: (v: number, a: number, b: number) => Math.max(a, Math.min(b, v)) };
  runInNewContext(dock + "result=dockHeight()", context);
  return context.result;
}

test("default conversation uses 45% of available space, including a banner and short screens", () => {
  for (const viewport of [414, 600, 844, 900, 1200]) for (const banner of [0, 48]) {
    const available = viewport - 48 - banner;
    expect(height(viewport, null, banner)).toBeGreaterThanOrEqual(available * .4);
    expect(available - height(viewport, null, banner)).toBeGreaterThanOrEqual(120);
  }
  expect(height(900, null)).toBeCloseTo(852 * .45);
  expect(height(414, null)).toBe(240);
});

test("saved pixel heights survive viewport clamping and null restores responsive sizing", () => {
  expect(height(900, 232)).toBe(232);
  expect(height(414, 460)).toBe(246);
  expect(height(900, 460)).toBe(460);
  expect(height(900, null)).not.toBe(232);
});

test("many sessions stay readable, selected work anchors after updates, and overview remains available", () => {
  const tasks = Array.from({ length: 60 }, (_, i) => ({ id: `T-${i}`, x: 310, y: 32 + i * 150 }));
  const context: any = { S: { tasks: new Map(tasks.map(t => [t.id, t])), foreign: new Map(), layout: "tree", sel: null },
    view: { x: 0, y: 0, k: 1, manual: false }, MINZ: .2, canvas: { clientWidth: 896, clientHeight: 460 },
    gwEl: { offsetLeft: 32, offsetTop: 32, offsetWidth: 210, offsetHeight: 54 },
    document: { getElementById: () => ({ offsetWidth: 230, offsetHeight: 110 }) },
    $: () => ({ classList: { remove() {} } }), graphTasks: () => tasks, graphTaskVisible: Boolean,
    foreignArr: () => [], applyView() {} };
  const code = app.slice(app.indexOf("function graphBoxes(){"), app.indexOf("function maybeFit(){"));
  runInNewContext(code + "readable()", context);
  expect(context.view.k).toBe(1);
  context.S.sel = "T-59";
  runInNewContext("readable()", context);
  expect(context.view.y + tasks[59].y).toBe(24);
  runInNewContext("fit()", context);
  expect(context.view.k).toBeLessThan(1);
  expect(context.view.y + (tasks[59].y + 110) * context.view.k).toBeLessThanOrEqual(460 - 64);
});
