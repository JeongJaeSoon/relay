import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const code = app.slice(app.indexOf("function inlineText("), app.indexOf("const pad="));
class Element {
  children: any[] = [];
  listeners: Record<string, () => void> = {};
  constructor(public tag: string, public textContent = "") {}
  append(...children: any[]) { this.children.push(...children); }
  addEventListener(event: string, fn: () => void) { this.listeners[event] = fn; }
}
function setup() {
  const sent: any[] = [];
  const context: any = {
    el: (tag: string, _cls: string, text = "") => new Element(tag, text),
    document: { createTextNode: (text: string) => new Element("#text", text) },
    answerQuestion: (...args: any[]) => sent.push(args),
  };
  runInNewContext(code, context);
  return { context, sent };
}
test("inline code is a text-only element and answer dispatch preserves the original string", () => {
  const { context, sent } = setup();
  const task = { id: "synthetic" };
  const source = '직렬화 `<img src=x onerror=alert(1)>` / 검증 `exportJson` 테스트';
  const b = context.questionOption(task, source);
  expect(b.children.filter((n: Element) => n.tag === "code").map((n: Element) => n.textContent))
    .toEqual(["<img src=x onerror=alert(1)>", "exportJson"]);
  expect(b.children.every((n: Element) => ["#text", "code"].includes(n.tag))).toBe(true);
  b.listeners.click();
  expect(sent).toEqual([[task, source]]);
});
test("unmatched, repeated and multiline backticks stay literal; long code gains no hidden characters", () => {
  const { context } = setup();
  for (const source of ["literal `unclosed", "``double``", "```fenced```", "`two\nlines`", "plain 한국어 테스트"]) {
    const node = context.inlineText(new Element("div"), source);
    expect(node.children.filter((n: Element) => n.tag === "code")).toHaveLength(0);
    expect(node.children.map((n: Element) => n.textContent).join("")).toBe(source);
  }
  const token = "긴단일식별자_" + "X".repeat(300);
  const node = context.inlineText(new Element("div"), "`" + token + "`");
  expect(node.children.find((n: Element) => n.tag === "code").textContent).toBe(token);
});
