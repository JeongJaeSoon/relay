import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const code = app.slice(app.indexOf("function focusKey("), app.indexOf("function refresh(){"));
function environment(width: number) {
  const nodes = new Map<string, any>();
  const document: any = { activeElement: null, body: {}, querySelector: () => null, querySelectorAll: () => [], getElementById: (id: string) => nodes.get(id) };
  function node(id: string, root?: string) {
    const classes = new Set<string>();
    const n: any = { id, dataset: {}, tagName: "BUTTON", textContent: id, isConnected: true, inert: false, visible: true, children: [],
      classList: { contains: (c: string) => classes.has(c), add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
      getClientRects: () => n.visible ? [1] : [],
      closest: (selector: string) => selector === "[inert]" ? (n.inert || (root && nodes.get(root).inert) ? n : null) : selector === "details" ? null : selector === "#nodes" ? (root === "nodes" ? nodes.get(root) : null) : root ? nodes.get(root) : null,
      querySelectorAll: () => n.children,
      focus: (options?: any) => { document.activeElement = n; n.lastFocusOptions = options; },
    };
    nodes.set(id, n); return n;
  }
  for (const id of ["app", "canvas", "sidebar", "detail", "dBody", "dHead", "sidebarBtn", "palBtn"]) node(id);
  const context: any = { document, $: (id: string) => nodes.get(id.slice(1)), appEl: nodes.get("app"),
    window: { matchMedia: (query: string) => ({ matches: width <= Number(query.match(/\d+/)![0]) }) },
    getComputedStyle: () => ({ visibility: "visible" }),
  };
  runInNewContext(code, context);
  return { context, nodes, document, node };
}
test("narrow detail and compact task-list overlays disable only covered regions", () => {
  for (const width of [390, 800, 1024]) {
    const { context: c, nodes: n } = environment(width);
    n.get("detail").classList.add("open"); c.syncOverlayAccess();
    expect(n.get("canvas").inert).toBe(width <= 980);
    expect(n.get("sidebar").inert).toBe(width <= 980);
    expect(n.get("detail").inert).toBe(false);
    n.get("app").classList.add("compact-sb-open"); c.syncOverlayAccess();
    if (width <= 640) { expect(n.get("detail").inert).toBe(true); expect(n.get("sidebar").inert).toBe(false); }
  }
});
test("refresh restores an equivalent task row but never reuses an old answer key for a new question", () => {
  const { context: c, nodes: n, document: d, node } = environment(1440);
  const old = node("old", "sidebar"); old.dataset.focusKey = "task:T-01"; old.focus();
  const saved = c.captureFocus(); old.isConnected = false;
  const fresh = node("fresh", "sidebar"); fresh.dataset.focusKey = "task:T-01"; n.get("sidebar").children = [fresh];
  c.restoreFocus(saved, true); expect(d.activeElement).toBe(fresh);
  expect(fresh.lastFocusOptions.preventScroll).toBe(false);
  const answer = node("old-answer", "dBody"); answer.dataset.focusKey = '["answer","task","question one","OK"]'; answer.focus();
  const oldAnswer = c.captureFocus(); answer.isConnected = false;
  const newAnswer = node("new-answer", "dBody"); newAnswer.dataset.focusKey = '["answer","task","question two","OK"]'; n.get("dBody").children = [newAnswer];
  c.restoreFocus(oldAnswer, true); expect(d.activeElement.id).toBe("dHead");
});
test("modal Tab wraps at both ends and background content becomes inert", () => {
  const { context: c, nodes: n, document: d, node } = environment(1440);
  const first = node("modal-first"), last = node("modal-last");
  first.tabIndex = 0; last.tabIndex = 0;
  const modal = { querySelectorAll: () => [first, last] };
  d.querySelector = () => modal;
  const section = app.slice(app.indexOf("function trapModalTab("), app.indexOf('document.addEventListener("keydown",trapModalTab)'));
  runInNewContext(section, c);
  c.syncOverlayAccess(); expect(n.get("app").inert).toBe(true);
  let prevented = 0;
  const press = (shiftKey: boolean) => c.trapModalTab({ key: "Tab", shiftKey, preventDefault: () => prevented++ });
  last.focus(); press(false); expect(d.activeElement).toBe(first);
  first.focus(); press(true); expect(d.activeElement).toBe(last);
  expect(prevented).toBe(2);
  d.querySelector = () => null; c.syncOverlayAccess(); expect(n.get("app").inert).toBe(false);
});
test("refresh leaves a live composer alone and closing an overlay cannot return to a hidden row", () => {
  const { context: c, nodes: n, document: d, node } = environment(390);
  const input = node("input"); input.focus(); const typing = c.captureFocus();
  c.restoreFocus(typing, true); expect(d.activeElement).toBe(input);
  const row = node("row", "sidebar"); row.focus(); const origin = c.captureFocus();
  row.visible = false; n.get("dHead").visible = false;
  c.restoreFocus(origin, true); expect(d.activeElement.id).toBe("sidebarBtn");
});
