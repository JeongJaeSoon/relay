import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Exercise the actual fit code: checking document scrollWidth alone misses content clipped by the canvas.
const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const fitCode = app.slice(app.indexOf("function graphBoxes(){"), app.indexOf("function maybeFit(){"));
function scene(width: number, height: number, layout: string, populated = false) {
  const hint = { style: { left: "278px", top: "38px", width: "400px" },
    get offsetLeft() { return parseFloat(this.style.left); }, get offsetTop() { return parseFloat(this.style.top); },
    get offsetWidth() { return parseFloat(this.style.width); }, offsetHeight: 80 };
  const gateway = { offsetLeft: 32, offsetTop: 32, offsetWidth: 210, offsetHeight: 54 };
  const view = { x: 0, y: 0, k: 1, manual: true };
  const tasks = populated ? [{ id: "T-01", x: 310, y: 32, status: "done" }] : [];
  const context = { view, S: { layout }, MINZ: .2, canvas: { clientWidth: width, clientHeight: height }, gwEl: gateway,
    $: (selector: string) => selector === "#emptyHint" ? hint : { classList: { remove() {} } },
    tasksArr: () => tasks, foreignArr: () => [], document: { getElementById: () => ({ offsetWidth: 210, offsetHeight: 90 }) }, applyView() {} };
  runInNewContext(fitCode + "\nfit();", context);
  const rect = (el: typeof gateway) => ({ left: view.x + el.offsetLeft * view.k, top: view.y + el.offsetTop * view.k,
    right: view.x + (el.offsetLeft + el.offsetWidth) * view.k, bottom: view.y + (el.offsetTop + el.offsetHeight) * view.k });
  return { hint: rect(hint), gateway: rect(gateway), view };
}

test("empty guidance stays inside the canvas and clear of gateway, zoom and legend in both layouts", () => {
  for (const layout of ["tree", "radial"]) for (const [w, h] of [[896, 620], [736, 520], [568, 520], [390, 564], [320, 320], [736, 312]]) {
    const { hint, gateway } = scene(w, h, layout);
    expect(hint.left).toBeGreaterThanOrEqual(0); expect(hint.right).toBeLessThanOrEqual(w);
    expect(hint.top).toBeGreaterThanOrEqual(gateway.bottom + 10);
    expect(hint.bottom).toBeLessThanOrEqual(h - 64);
    // Zoom buttons occupy the top-right 30 x 102 px; a hint may pass beside or below them.
    expect(hint.right <= w - 42 || hint.top >= 114).toBe(true);
  }
});

test("hidden empty guidance does not change a populated graph's fit", () => {
  const { view } = scene(896, 620, "tree", true);
  expect(view).toEqual({ x: -4, y: -8, k: 1, manual: false });
});
