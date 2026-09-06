import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const shell = app.slice(app.indexOf("const RZ=Object.assign("), app.indexOf("/* ================= shortcuts"));
function setup(saved: Record<string, unknown> = {}, viewport = 900) {
  const nodes = new Map<string, any>(); const properties = new Map<string, string>();
  let stored = JSON.stringify(saved); let writes = 0;
  const node = (selector: string) => {
    if (!nodes.has(selector)) {
      const classes = new Set<string>(); const handlers: Record<string, (event?: any) => void> = {};
      const attributes: Record<string, string> = {};
      nodes.set(selector, { handlers, attributes, offsetHeight: 0,
        classList: {
          contains: (name: string) => classes.has(name),
          add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name),
          toggle(name: string, forced?: boolean) { const value = forced ?? !classes.has(name); if (value) classes.add(name); else classes.delete(name); return value; },
        },
        setAttribute: (name: string, value: string) => attributes[name] = value,
        addEventListener: (name: string, fn: (event?: any) => void) => handlers[name] = fn,
        setPointerCapture() {}, getBoundingClientRect: () => ({ top: 48, bottom: viewport, left: 0, right: 1200 }),
      });
    }
    return nodes.get(selector);
  };
  const context: any = {
    localStorage: { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; writes++; } },
    document: { documentElement: { clientHeight: viewport, style: { setProperty: (name: string, value: string) => properties.set(name, value) } }, getElementById: (id: string) => node("#" + id), querySelector: node },
    $: node, window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
    captureFocus() {}, restoreFocus() {}, updateMinimap() {}, syncOverlayAccess() {},
    S: { sel: null, fsel: null },
  };
  runInNewContext(shell + "\nglobalThis.settings=RZ;", context);
  return { node, context, properties, saved: () => JSON.parse(stored), writes: () => writes };
}

test("Requests collapse independently of Messages and task detail, and restore their saved preference", () => {
  const h = setup({ ch: false, dt: true, chh: 400, rqh: 360 });
  expect(h.context.settings.dt).toBe(false);
  const toggle = h.node("#requestsToggle");
  toggle.handlers.click();
  expect(h.node("#ledger").classList.contains("collapsed")).toBe(true);
  expect(toggle.attributes["aria-expanded"]).toBe("false");
  expect(h.saved()).toMatchObject({ rqOpen: false, ch: false, chh: 400, rqh: 360 });
  const reloaded = setup(h.saved());
  expect(reloaded.node("#ledger").classList.contains("collapsed")).toBe(true);
  reloaded.node("#requestsToggle").handlers.click();
  expect(reloaded.saved()).toMatchObject({ rqOpen: true, ch: false, chh: 400, rqh: 360 });
  expect(reloaded.properties.get("--request-height")).toBe("360px");
});

test("Requests keyboard resize is bounded, resets with Home, and preserves conversation height", () => {
  const h = setup({ chh: 410 }); const handle = h.node(".rz-requests");
  let prevented = 0;
  const key = (key: string) => handle.handlers.keydown({ key, preventDefault() { prevented++; } });
  key("ArrowUp"); expect(h.saved().rqh).toBe(324);
  expect(handle.attributes["aria-valuenow"]).toBe("324");
  key("ArrowDown"); expect(h.saved().rqh).toBe(300);
  for (let i = 0; i < 40; i++) key("ArrowDown");
  expect(h.saved().rqh).toBe(120);
  for (let i = 0; i < 40; i++) key("ArrowUp");
  expect(h.saved().rqh).toBe(732);
  key("Home"); expect(h.saved()).toMatchObject({ rqh: 300, chh: 410 });
  const writes = h.writes(); const oldPrevented = prevented;
  key("Tab"); expect(h.writes()).toBe(writes); expect(prevented).toBe(oldPrevented);
});

test("Requests pointer resize and reset save independently; a short viewport clamps the effective request height", () => {
  const h = setup({ chh: 400 }); const handle = h.node(".rz-requests");
  handle.handlers.pointerdown({ pointerId: 1, preventDefault() {} });
  handle.handlers.pointermove({ clientY: 450 }); handle.handlers.pointerup();
  expect(h.saved()).toMatchObject({ rqh: 450, chh: 400 });
  expect(h.properties.get("--request-height")).toBe("450px");
  const short = setup(h.saved(), 400);
  expect(short.properties.get("--request-height")).toBe("232px");
  expect(short.context.settings.rqh).toBe(450);
  expect(short.node(".rz-requests").attributes).toMatchObject({ "aria-valuemin": "120", "aria-valuemax": "232", "aria-valuenow": "232" });
  short.node(".rz-requests").handlers.keydown({ key: "ArrowDown", preventDefault() {} });
  expect(short.properties.get("--request-height")).toBe("208px");
  handle.handlers.dblclick();
  expect(h.saved()).toMatchObject({ rqh: 300, chh: 400 });
});

test("legacy alignment is retired while existing widths and conversation preferences survive", () => {
  const h = setup({ align: "justify", sbw: 420, chh: 360, rqOpen: false });
  h.node("#requestsToggle").handlers.click();
  expect(h.saved().align).toBeUndefined();
  expect(h.saved()).toMatchObject({ sbw: 420, chh: 360, rqh: 300 });
});

test("opening Messages dismisses the compact sidebar without changing Requests' collapse preference", () => {
  const calls: string[] = [];
  const context: any = { closeCompactSidebar: () => calls.push("close"), syncOverlayAccess: () => calls.push("access"), RZ: { rqOpen: false } };
  const code = app.slice(app.indexOf("function showChatPane("), app.indexOf("function focusComposer("));
  runInNewContext(code, context); context.showChatPane("messages");
  expect(calls).toEqual(["close", "access"]);
  expect(context.RZ.rqOpen).toBe(false);
});
