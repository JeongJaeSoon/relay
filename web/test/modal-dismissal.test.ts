import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
function setup(modal: "palette" | "editor", chatVisible = true) {
  let active: string = modal, pane = "requests", inert = true, restored = 0;
  const classes = new Set(modal === "editor" ? ["open"] : []);
  const bindings: Record<string, any> = {};
  const context: any = {
    PAL: { open: modal === "palette" },
    palEl: { classList: { remove() {} } },
    kedEl: { classList: { contains: (name: string) => classes.has(name), remove: (name: string) => classes.delete(name) } },
    paletteOrigin: {}, RZ: { ch: chatVisible },
    input: { value: "existing draft", focus() { if (!inert && context.RZ.ch && pane === "messages") active = "composer"; } },
    syncOverlayAccess() { inert = context.PAL.open || classes.has("open"); },
    togglePanel(name: string) { expect(name).toBe("ch"); context.RZ.ch = !context.RZ.ch; },
    showChatPane(name: string) { pane = name; },
    restoreFocus() { restored++; active = "origin"; },
    document: { addEventListener: (name: string, fn: any) => bindings[name] = fn },
  };
  const functions = ["closePalette", "closeKeysEd", "runPal", "focusComposer"]
    .map(name => app.match(new RegExp(`^function ${name}\\(.*$`, "m"))![0]).join("\n");
  const start = app.indexOf('document.addEventListener("keydown",e=>{', app.indexOf('$("#dClose")'));
  runInNewContext(functions + "\n" + app.slice(start, app.indexOf("/* ================= pan / zoom", start)), context);
  return { context, state: () => ({ active, pane, inert, restored }),
    escape() {
      let prevented = false, stopped = false;
      bindings.keydown({ key: "Escape", preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
      return { prevented, stopped };
    },
  };
}

test("one delivered Escape dismisses either modal into the visible composer, retaining its draft", () => {
  for (const modal of ["palette", "editor"] as const) for (const visible of [true, false]) {
    const c = setup(modal, visible);
    expect(c.escape()).toEqual({ prevented: true, stopped: true });
    expect(c.state()).toEqual({ active: "composer", pane: "messages", inert: false, restored: 0 });
    expect(c.context.input.value).toBe("existing draft");
  }
});

test("button/backdrop dismissal shares the composer destination", () => {
  for (const modal of ["palette", "editor"] as const) {
    const c = setup(modal, false);
    c.context[modal === "palette" ? "closePalette" : "closeKeysEd"]();
    expect(c.state().active).toBe("composer");
    expect(c.state().inert).toBe(false);
  }
});

test("executing a palette command preserves its own focus and panel behavior", () => {
  const c = setup("palette", false);
  let ran = false;
  c.context.runPal({ run() { ran = true; expect(c.state().inert).toBe(false); } });
  expect(ran).toBe(true);
  expect(c.state()).toEqual({ active: "origin", pane: "requests", inert: false, restored: 1 });
  expect(c.context.RZ.ch).toBe(false);
});

test("a clicked palette command cannot immediately close its panel as an outside click", () => {
  const items: any[] = [];
  let panelOpen = false, propagated = true;
  const context: any = {
    PAL: { idx: 0, list: [] }, palInput: { value: "", setAttribute() {} },
    palList: { textContent: "", append: (item: any) => items.push(item), querySelector: () => null },
    commands: () => [{ t: "Open settings", run() { panelOpen = true; } }],
    closePalette() {},
    el: () => ({ handlers: {} as Record<string, any>, append() {}, setAttribute() {},
      addEventListener(name: string, fn: any) { this.handlers[name] = fn; } }),
  };
  const start = app.indexOf("function renderPal(){");
  const end = app.indexOf('palInput.addEventListener("input"', start);
  runInNewContext(app.slice(start, end), context);
  context.renderPal();
  items[0].handlers.click({ stopPropagation() { propagated = false; } });
  // The document's outside-click handler would dismiss the newly opened panel.
  if (propagated) panelOpen = false;
  expect(propagated).toBe(false);
  expect(panelOpen).toBe(true);
});
