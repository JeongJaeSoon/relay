import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const dock = app.slice(app.indexOf("function contentHeight()"), app.indexOf("function applySizes(){"));
function height(viewport: number, saved: number | null, banner = 0, width = 390) {
  const context: any = { RZ: { chh: saved }, document: { documentElement: { clientHeight: viewport, clientWidth: width } },
    $: () => ({ offsetHeight: banner }), clampNum: (v: number, a: number, b: number) => Math.max(a, Math.min(b, v)) };
  runInNewContext(dock + "result=dockHeight()", context);
  return context.result;
}

test("default conversation uses 41.5% of available content while retaining canvas room", () => {
  for (const viewport of [414, 600, 844, 900, 1200]) for (const banner of [0, 48]) {
    const available = viewport - 48 - banner;
    expect(height(viewport, null, banner)).toBeGreaterThanOrEqual(available * .4);
    expect(available - height(viewport, null, banner)).toBeGreaterThanOrEqual(180);
  }
  expect(height(900, null)).toBeCloseTo(852 * .415);
  expect(height(414, null)).toBeCloseTo(366 * .415);
});

test("saved ratios retain a drag choice through viewport resize", () => {
  expect(height(900, .5)).toBeCloseTo(852 * .5);
  expect(height(1200, .5, 0, 1280)).toBeCloseTo(1152 * .5);
  expect(height(414, .5)).toBe(183);
  expect(height(900, null)).toBeCloseTo(852 * .415);
});

test("mobile conversation heights cannot dominate the workspace", () => {
  for (const viewport of [414, 600, 844, 900, 1200, 2000]) for (const banner of [0, 48]) {
    const available = viewport - 48 - banner;
    const actual = height(viewport, 1600, banner);
    expect(actual).toBeLessThanOrEqual(520);
    expect(actual).toBeLessThanOrEqual(available * .55);
    expect(available - actual).toBeGreaterThanOrEqual(180);
  }
  expect(height(2000, null)).toBe(520);
  expect(height(2000, .9)).toBe(520);
});

test("desktop permits ratios beyond the mobile cap while keeping a usable canvas", () => {
  expect(height(2000, .82, 0, 1280)).toBeCloseTo(1952 * .82);
  expect(height(1200, .7, 0, 1280)).toBeCloseTo(1152 * .7);
  expect(height(1200, .7, 0, 640)).toBe(520);
  expect(height(1200, .7, 0, 641)).toBeCloseTo(1152 * .7);
  expect(height(900, 1, 0, 1280)).toBe(732);
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
