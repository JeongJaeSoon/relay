import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
class Node {
  children: Node[] = []; attrs: Record<string,string> = {}; handlers: Record<string,any> = {};
  classList = { toggle() {} }; textContent = ""; disabled = false; clicks = 0;
  constructor(public tag = "div", public cls = "", text = "") { this.textContent = text; }
  append(...nodes: Node[]) { this.children.push(...nodes); }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(key: string, fn: any) { this.handlers[key] = fn; }
  click() { this.clicks++; this.handlers.click?.({ stopPropagation() {} }); }
}
const el = (tag: string, cls: string, text?: string) => new Node(tag, cls, text);

test("keyboard activation of a dismiss button cannot also activate its notification card", () => {
  let dismissed = 0;
  const c: any = { el, clock: () => "12:00", dropNotif: () => dismissed++, renderNotif() {} };
  runInNewContext(app.slice(app.indexOf("function ncard("), app.indexOf("function renderToasts(")), c);
  const card: Node = c.ncard({ kind: "done", title: "Task", body: "Finished" });
  const dismiss = card.children[2]!;
  card.handlers.keydown({ target: dismiss, key: "Enter", preventDefault() { throw new Error("nested button event consumed"); } });
  dismiss.click();
  expect(dismissed).toBe(1); expect(card.clicks).toBe(0);
  card.handlers.keydown({ target: card, key: "Enter", preventDefault() {} });
  expect(card.clicks).toBe(1);
});

test("empty notification panel disables clear and reports open/count/DND state accessibly", () => {
  const body = new Node(), badge = new Node(), button: any = new Node(), clear = new Node(), dnd = new Node();
  button.querySelector = () => badge;
  const c: any = { el, N: { items: [], dnd: true, open: true }, notifBtn: button,
    ncEl: { classList: { toggle() {} }, querySelector: () => body }, $: (id: string) => id === "#ncClear" ? clear : dnd };
  runInNewContext(app.slice(app.indexOf("function renderCenter("), app.indexOf("function renderNotif(")), c);
  c.renderCenter();
  expect(clear.disabled).toBe(true); expect(button.attrs["aria-expanded"]).toBe("true");
  expect(button.attrs["aria-label"]).toContain("Do not disturb");
  expect(body.children[0]!.children[0]!.textContent).toBe("You’re all caught up");
  c.N.open = false; c.N.items = Array(105).fill({}); c.renderCenter();
  expect(clear.disabled).toBe(false); expect(badge.textContent).toBe("99+");
  expect(button.attrs["aria-label"]).toContain("105 unread");
  expect(button.attrs["aria-expanded"]).toBe("false");
});
