import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
function setup() {
  const tasks = Array.from({ length: 60 }, (_, i) => ({ id: `T-${i}`, x: 310, y: 32 + i * 150 }));
  const nodes = new Map<string, any>();
  const node = (id: string) => {
    if (!nodes.has(id)) {
      const classes = new Set<string>();
      nodes.set(id, { attributes: {}, handlers: {}, title: "", textContent: "", classList: {
        add: (s: string) => classes.add(s), remove: (s: string) => classes.delete(s),
        contains: (s: string) => classes.has(s),
        toggle(s: string, value: boolean) { if (value) classes.add(s); else classes.delete(s); },
      }, setAttribute(name: string, value: string) { this.attributes[name] = value; },
      addEventListener(name: string, handler: () => void) { this.handlers[name] = handler; } });
    }
    return nodes.get(id);
  };
  const c: any = {
    S: { tasks: new Map(tasks.map(t => [t.id, t])), foreign: new Map(), sel: "T-59", layout: "tree", reduce: true },
    canvas: { clientWidth: 896, clientHeight: 460 }, world: { style: {} },
    gwEl: { offsetLeft: 32, offsetTop: 32, offsetWidth: 260, offsetHeight: 54 },
    document: { getElementById: () => ({ offsetWidth: 320, offsetHeight: 110 }) },
    $: node, graphTasks: () => tasks, graphTaskVisible: Boolean, foreignArr: () => [], updateMinimap() {},
  };
  const code = app.slice(app.indexOf("const MINZ="), app.indexOf('canvas.addEventListener("wheel"'));
  const binding = app.match(/\$\("#zfit"\)\.addEventListener\("click",toggleOverview\);/)![0];
  runInNewContext(code + binding + "\nglobalThis.state=view;readable();", c);
  return { c, tasks, button: node("#zfit") };
}

test("minimap corner button toggles full overview and readable selected-task context with matching accessible state", () => {
  const { c, tasks, button } = setup();
  expect(c.state.k).toBe(1);
  expect(button.attributes).toMatchObject({ "aria-pressed": "false", "aria-label": "Fit all tasks" });
  button.handlers.click();
  expect(c.state.overview).toBe(true); expect(c.state.manual).toBe(true);
  expect(c.state.k).toBeLessThan(1);
  expect(button.classList.contains("overview")).toBe(true);
  expect(button.attributes).toMatchObject({ "aria-pressed": "true", "aria-label": "Return to readable view" });
  expect(button.title).toBe("Return to readable view");
  button.handlers.click();
  expect(c.state.overview).toBe(false); expect(c.state.manual).toBe(false); expect(c.state.k).toBe(1);
  expect(c.state.y + tasks[59].y).toBe(24);
  expect(button.classList.contains("overview")).toBe(false);
  expect(button.attributes).toMatchObject({ "aria-pressed": "false", "aria-label": "Fit all tasks" });
});

test("focusing a task from overview resets the minimap toggle to readable mode", () => {
  const { c, tasks, button } = setup();
  button.handlers.click();
  c.centerOn(tasks[2]);
  expect(c.state.overview).toBe(false); expect(c.state.k).toBe(1);
  expect(button.attributes["aria-pressed"]).toBe("false");
  expect(button.title).toBe("Fit all tasks");
});

test("resizing the minimap recomputes viewport scale from its visible surface", () => {
  const source = app.slice(app.indexOf("function updateMinimap(){"), app.indexOf("function mmJump(e){"));
  const surface: any = { clientWidth: 170, clientHeight: 114, textContent: "", append() {} };
  const c: any = { mmEl: surface, mmShell: { style: {} }, graphTasks: () => [{}], S: { foreign: new Map() }, graphBoxes: () => [{ x: 0, y: 0, w: 320, h: 100, st: "run" }], view: { x: 0, y: 0, k: 1 }, canvas: { clientWidth: 800, clientHeight: 400 }, el: () => ({ style: {} }) };
  runInNewContext(source, c);
  c.updateMinimap();
  const initial = c.mmMap.mk;
  surface.clientWidth = 258;surface.clientHeight = 174;
  c.updateMinimap();
  expect(c.mmMap.mk).toBeGreaterThan(initial);
  expect(c.mmMap.mk).toBe(Math.min(258 / 888, 174 / 488));
});


test("readable view anchors the first retained Claude session when no Relay task exists", () => {
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const fit = app.slice(app.indexOf("function fit("), app.indexOf("function readable("));
  const session = { key: "retained", x: 1120, y: 32 };
  const context: any = {
    S: { layout: "tree", sel: null, fsel: null }, view: {},
    graphBoxes: () => [{ x: 32, y: 32, w: 260, h: 62 }, { x: 1120, y: 32, w: 300, h: 110 }],
    emptyHintBox: () => null, graphTasks: () => [], foreignArr: () => [session],
    canvas: { clientWidth: 676, clientHeight: 550 }, $: () => ({ classList: { remove() {} } }), applyView() {},
  };
  runInNewContext(fit + "fit(1);", context);
  expect(context.view.x + session.x).toBe(28);
  expect(context.view.y + session.y).toBe(24);
  expect(context.view.k).toBe(1);
});
