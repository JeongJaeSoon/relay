import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Run the actual classic-script input bindings with minimal event targets. No copied submit logic.
const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const section = app.split("/* ================= input ================= */")[1].split("/* ================= module bridge ================= */")[0];
function composer(send: (...args: any[]) => Promise<boolean>) {
  const controls = new Map<string, any>();
  const storage = new Map<string, string>();
  const $ = (id: string) => {
    if (!controls.has(id)) controls.set(id, { value: "", style: {}, attrs: {}, handlers: {}, disabled: false, readOnly: false,
      scrollHeight: 38, offsetHeight: 38, clientHeight: 36, focus() {},
      setAttribute(k: string, v: string) { this.attrs[k] = v; },
      addEventListener(k: string, fn: any) { this.handlers[k] = fn; },
      requestSubmit() { return this.handlers.submit({ preventDefault() {} }); },
    });
    return controls.get(id);
  };
  const panes: string[] = [];
  const context: any = { $, RZ: { ch: true }, showChatPane: (pane: string) => panes.push(pane), relay: { send }, localStorage: {
    getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k),
  } };
  runInNewContext(app.match(/^function send\(text\).*$/m)![0] + "\n" + section, context);
  return { input: $("#input"), button: $("#sendBtn"), ask: $("#askBtn"), storage, panes,
    type(text: string) { $("#input").value = text; $("#input").handlers.input(); },
    submit: () => $("#chatForm").requestSubmit(),
    askAbout: (t: any) => context.askAbout(t),
  };
}

test("failed submission retains the draft and task-scoped Ask for retry", async () => {
  const calls: any[] = []; let ok = false;
  const c = composer(async (...args) => { calls.push(args); return ok; });
  c.askAbout({ uuid: "uuid-1", id: "T-01" }); c.type("어떤 파일을 확인했어?");
  expect(c.panes).toEqual(["messages"]);
  await c.submit();
  expect(c.input.value).toBe("어떤 파일을 확인했어?");
  expect(c.storage.get("relay-draft")).toBe(c.input.value);
  ok = true; await c.submit();
  expect(calls).toEqual([["어떤 파일을 확인했어?", true, "uuid-1"], ["어떤 파일을 확인했어?", true, "uuid-1"]]);
  expect(c.input.value).toBe(""); expect(c.storage.has("relay-draft")).toBe(false);
});

test("submission waits for acknowledgement and ignores repeated Enter while pending", async () => {
  let finish!: (ok: boolean) => void; let calls = 0;
  const c = composer(() => { calls++; return new Promise(r => { finish = r; }); });
  c.type("myapp refactor"); const pending = c.submit(); await c.submit();
  expect(calls).toBe(1); expect(c.input.value).toBe("myapp refactor");
  expect(c.button.disabled).toBe(true);
  finish(true); await pending;
  expect(c.input.value).toBe(""); expect(c.button.disabled).toBe(false);
});

test("blank Ask and IME confirmation never send a request", async () => {
  let calls = 0; const c = composer(async () => { calls++; return true; });
  c.type("?   "); await c.submit(); expect(calls).toBe(0);
  c.type("한글");
  c.input.handlers.keydown({ key: "Enter", isComposing: true });
  c.input.handlers.keydown({ key: "Enter", keyCode: 229 });
  c.input.handlers.keydown({ key: "Enter", shiftKey: true });
  expect(calls).toBe(0);
});
