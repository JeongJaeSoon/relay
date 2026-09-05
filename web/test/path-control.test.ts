import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { toDemoForeign } from "../src/adapter.ts";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const code = app.slice(app.indexOf("const pathCopyState="), app.indexOf("const tasksArr="));
class Element {
  children: Element[] = [];
  listeners: Record<string, () => Promise<void>> = {};
  disabled = false;
  constructor(public tag: string, public textContent = "") {}
  append(...children: Element[]) { this.children.push(...children); }
  querySelector(selector: string) { return this.children[selector === "button" ? 1 : 2]; }
  setAttribute() {}
  addEventListener(event: string, fn: () => Promise<void>) { this.listeners[event] = fn; }
}
function control(path: string | null, clipboard?: any) {
  const live: any[] = [];
  const context: any = { document: { querySelectorAll: () => live }, navigator: { clipboard }, uiIcon: () => new Element("svg"),
    el: (tag: string, _cls: string, text = "") => new Element(tag, text) };
  runInNewContext(code, context);
  const box = context.pathControl(path, "directory");
  live.push(box);
  return { value: box.children[0], button: box.children[1], status: box.children[2],
    replace: () => { const next = context.pathControl(path, "directory"); live.splice(0, 1, next); return next; },
  };
}
test("copy reports success only after clipboard confirms the exact unmodified path", async () => {
  let resolve!: () => void;
  const copied: string[] = [];
  const path = "/workspace/synthetic/한글 폴더/long-directory";
  const { value, button, status } = control(path, { writeText: (text: string) => {
    copied.push(text); return new Promise<void>(r => resolve = r);
  } });
  const pending = button.listeners.click();
  expect(value.textContent).toBe(path); expect(copied).toEqual([path]);
  expect(status.textContent).toBe("Copying…"); expect(button.disabled).toBe(true);
  resolve(); await pending;
  expect(status.textContent).toBe("Path copied."); expect(button.disabled).toBe(false);
});
test("denied or unavailable clipboard reports failure; a missing path has no enabled action", async () => {
  for (const clipboard of [undefined, { writeText: () => Promise.reject(new Error("denied")) }]) {
    const { button, status } = control("/workspace/synthetic/project", clipboard);
    await button.listeners.click();
    expect(status.textContent).toContain("Could not copy"); expect(button.disabled).toBe(false);
  }
  expect(control(null).button.disabled).toBe(true);
});
test("foreign adapter preserves an exact copy path separately from its display fallback", () => {
  const foreign = (cwd: string | null) => toDemoForeign({ session_id: "synthetic-session", cwd, first_seen: 1, last_seen: 2 } as any);
  const missing = foreign(null);
  expect(missing.cwd).toBe("—"); expect(control(missing.directoryPath).button.disabled).toBe(true);
  for (const path of ["/", "/workspace/synthetic/한글 폴더/"]) {
    expect(foreign(path).directoryPath).toBe(path);
    expect(control(foreign(path).directoryPath).button.disabled).toBe(false);
  }
});
test("a task update during copy retains pending state and delivers feedback to the replacement control", async () => {
  for (const ok of [true, false]) {
    let finish!: () => void;
    const c = control("/workspace/synthetic/project", { writeText: () => new Promise<void>((resolve, reject) => {
      finish = () => ok ? resolve() : reject(new Error("denied"));
    }) });
    const pending = c.button.listeners.click();
    const replacement = c.replace();
    expect(replacement.children[1].disabled).toBe(true);
    expect(replacement.children[2].textContent).toBe("Copying…");
    finish(); await pending;
    expect(replacement.children[1].disabled).toBe(false);
    expect(replacement.children[2].textContent).toBe(ok ? "Path copied." : "Could not copy. Select the path above to copy manually.");
  }
});
