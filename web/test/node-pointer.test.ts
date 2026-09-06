import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
test("pointer focus keeps task and outside nodes stationary until click opens detail", () => {
  for (const outside of [false, true]) {
    let centers = 0;
    const selection: { id: string | null } = { id: null };
    const handlers: Record<string, (event?: any) => void> = {};
    const create = () => ({ dataset: {}, classList: { remove() {} }, append() {}, setAttribute() {},
      addEventListener(type: string, handler: any) { handlers[type] = handler; } });
    const context: any = { document: { getElementById: () => null }, el: create, nodesBox: { append() {} },
      requestAnimationFrame: (fn: () => void) => fn(), centerOn: () => centers++, centerOnBox: () => centers++,
      select: (id: string) => { selection.id = id; }, selectForeign: (id: string) => { selection.id = id; } };
    const binding = app.slice(app.indexOf("function bindNodeFocus("), app.indexOf("function elapsedText("));
    const foreign = app.slice(app.indexOf("function foreignEl("), app.indexOf("function renderForeignNodes("));
    runInNewContext(binding + foreign, context);
    if (outside) context.foreignEl({ key: "outside" }); else context.nodeEl({ id: "T-01" });
    handlers.pointerdown(); handlers.focus();
    expect(centers).toBe(0);
    handlers.pointerup(); handlers.click({ stopPropagation() {} });
    expect(selection.id).toBe(outside ? "outside" : "T-01");
    handlers.blur(); handlers.focus(); expect(centers).toBe(1);
    handlers.pointerdown(); handlers.pointercancel(); handlers.focus(); expect(centers).toBe(2);
  }
});
