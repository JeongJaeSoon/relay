import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const shell = app.slice(app.indexOf("const RZ=Object.assign("), app.indexOf("/* ================= shortcuts"));
function setup(saved: Record<string, unknown> = {}, viewport = 900, width = 1200) {
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
    document: { documentElement: { clientHeight: viewport, clientWidth: width, style: { setProperty: (name: string, value: string) => properties.set(name, value) } }, getElementById: (id: string) => node("#" + id), querySelector: node },
    $: node, window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
    captureFocus() {}, restoreFocus() {}, updateMinimap() {}, syncOverlayAccess() {}, readable() {},
    S: { sel: null, fsel: null },
  };
  runInNewContext(shell + "\nglobalThis.settings=RZ;", context);
  return { node, context, properties, saved: () => JSON.parse(stored), writes: () => writes };
}

test("Requests collapse independently of Messages and retain ratio preferences after reload", () => {
  const h = setup({ version: 2, ch: false, dt: true, chh: .48, rqh: .42 });
  expect(h.context.settings.dt).toBe(false);
  const toggle = h.node("#requestsToggle");
  toggle.handlers.click();
  expect(h.node("#ledger").classList.contains("collapsed")).toBe(true);
  expect(toggle.attributes["aria-expanded"]).toBe("false");
  expect(h.saved()).toMatchObject({ version: 2, rqOpen: false, ch: false, chh: .48, rqh: .42 });
  const reloaded = setup(h.saved());
  expect(reloaded.node("#ledger").classList.contains("collapsed")).toBe(true);
  reloaded.node("#requestsToggle").handlers.click();
  expect(reloaded.saved()).toMatchObject({ version: 2, rqOpen: true, ch: false, chh: .48, rqh: .42 });
  expect(reloaded.properties.get("--request-height")).toBe("357.84px");
});

test("Requests keyboard resize is bounded, resets to the default ratio, and preserves conversation height", () => {
  const h = setup({ version: 2, chh: .48 }); const handle = h.node(".rz-requests");
  let prevented = 0;
  const key = (key: string) => handle.handlers.keydown({ key, preventDefault() { prevented++; } });
  key("ArrowUp"); expect(h.saved().rqh).toBeCloseTo(377.58 / 852);
  expect(handle.attributes["aria-valuenow"]).toBe("378");
  key("ArrowDown"); expect(h.saved().rqh).toBeCloseTo(.415);
  for (let i = 0; i < 40; i++) key("ArrowDown");
  expect(h.saved().rqh).toBeCloseTo(120 / 852);
  for (let i = 0; i < 40; i++) key("ArrowUp");
  expect(h.saved().rqh).toBeCloseTo(732 / 852);
  key("Home"); expect(h.saved()).toMatchObject({ rqh: .415, chh: .48 });
  const writes = h.writes(); const oldPrevented = prevented;
  key("Tab"); expect(h.writes()).toBe(writes); expect(prevented).toBe(oldPrevented);
});

test("Requests pointer resize persists a ratio and a short mobile viewport clamps its effective height", () => {
  const h = setup({ version: 2, chh: .48 }); const handle = h.node(".rz-requests");
  handle.handlers.pointerdown({ pointerId: 1, preventDefault() {} });
  handle.handlers.pointermove({ clientY: 450 }); handle.handlers.pointerup();
  expect(h.saved()).toMatchObject({ rqh: 450 / 852, chh: .48 });
  expect(parseFloat(h.properties.get("--request-height")!)).toBeCloseTo(450);
  const short = setup(h.saved(), 400, 390);
  expect(short.properties.get("--request-height")).toBe("172px");
  expect(short.context.settings.rqh).toBeCloseTo(450 / 852);
  expect(short.node(".rz-requests").attributes).toMatchObject({ "aria-valuemin": "120", "aria-valuemax": "172", "aria-valuenow": "172" });
  short.node(".rz-requests").handlers.keydown({ key: "ArrowDown", preventDefault() {} });
  expect(short.properties.get("--request-height")).toBe("148px");
  handle.handlers.dblclick();
  expect(h.saved()).toMatchObject({ rqh: .415, chh: .48 });
});

test("sidebar and chat drags save proportions that scale on reload", () => {
  const h = setup({ version: 2 }, 900, 2000);
  const sidebar = h.node(".rz-sb");
  sidebar.handlers.pointerdown({ pointerId: 1, preventDefault() {} });
  sidebar.handlers.pointermove({ clientX: 600 }); sidebar.handlers.pointerup();
  expect(h.saved().sbw).toBeCloseTo(.3);
  expect(h.properties.get("--sbw")).toBe("600px");

  const chat = h.node(".rz-ch");
  chat.handlers.pointerdown({ pointerId: 2, preventDefault() {} });
  chat.handlers.pointermove({ clientY: 500 }); chat.handlers.pointerup();
  expect(h.saved().chh).toBeCloseTo(400 / 852);

  const reloaded = setup(h.saved(), 1200, 1000);
  expect(reloaded.properties.get("--sbw")).toBe("300px");
  expect(parseFloat(reloaded.properties.get("--chh")!)).toBeCloseTo((400 / 852) * 1152);
});

test("legacy pixel sizes migrate to ratio defaults while retaining open state and detail width", () => {
  const h = setup({ align: "justify", sbw: 420, chh: 360, rqOpen: false });
  h.node("#requestsToggle").handlers.click();
  expect(h.saved().align).toBeUndefined();
  expect(h.saved()).toMatchObject({ version: 2, sbw: .214, chh: .415, rqh: .415, dw: 296, rqOpen: true });
});

test("opening Messages dismisses the compact sidebar without changing Requests' collapse preference", () => {
  const calls: string[] = [];
  const context: any = { closeCompactSidebar: () => calls.push("close"), syncOverlayAccess: () => calls.push("access"), RZ: { rqOpen: false } };
  const code = app.slice(app.indexOf("function showChatPane("), app.indexOf("function focusComposer("));
  runInNewContext(code, context); context.showChatPane("messages");
  expect(calls).toEqual(["close", "access"]);
  expect(context.RZ.rqOpen).toBe(false);
});


test("Messages header collapse saves visibility while preserving its ratio and independent Requests state", () => {
  const h = setup({ version: 2, ch: true, chh: .48, rqh: .39, rqOpen: false });
  const button = h.node("#messagesToggle");
  expect(button.attributes).toMatchObject({ "aria-expanded": "true", "aria-label": "Collapse Messages" });
  button.handlers.click();
  expect(h.node("#app").classList.contains("hide-ch")).toBe(true);
  expect(button.attributes).toMatchObject({ "aria-expanded": "false", "aria-label": "Expand Messages" });
  expect(h.saved()).toMatchObject({ ch: false, chh: .48, rqh: .39, rqOpen: false });
  const reloaded = setup(h.saved());
  expect(reloaded.node("#messagesToggle").attributes["aria-expanded"]).toBe("false");
  reloaded.node("#messagesToggle").handlers.click();
  expect(reloaded.node("#app").classList.contains("hide-ch")).toBe(false);
  expect(reloaded.saved()).toMatchObject({ ch: true, chh: .48, rqh: .39, rqOpen: false });
  expect(reloaded.properties.get("--chh")).toBe("408.96px");
});
