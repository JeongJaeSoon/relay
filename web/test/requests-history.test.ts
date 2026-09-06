import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  handlers: Record<string, (...args: any[]) => void> = {};
  scrollTop = 0;
  hidden = false;
  private text: string;
  constructor(public tag: string, public className = "", text = "") { this.text = text; }
  get textContent() { return this.text; }
  set textContent(value: string) { this.text = value; this.children = []; }
  get childElementCount() { return this.children.length; }
  classList = { add() {}, toggle() { return true; } };
  append(...children: Element[]) { this.children.push(...children); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, fn: (...args: any[]) => void) { this.handlers[name] = fn; }
}
function setup() {
  const list = new Element("div"); const count = new Element("span"); const jumps: any[] = [];
  const c: any = {
    $: (name: string) => name === "#lgList" ? list : count,
    el: (tag: string, cls = "", text = "") => new Element(tag, cls, text),
    captureFocus() {}, restoreFocus() {}, expandedRequests: new Set(), agentKey: (t: any) => t.uuid || t.id,
    S: { tasks: new Map() }, jumpToRequest: (r: any) => jumps.push(r),
  };
  const code = app.slice(app.indexOf("const LEDGER=[]"), app.indexOf("/* ================= server actions"));
  runInNewContext(code + "\nglobalThis.rows=LEDGER;", c);
  return { c, list, count, jumps };
}
const request = (id: string, bucket: string, st = "run") => ({ id, bucket, st, text: "Request " + id, state: st === "done" ? "Done" : "Running", disposition: "delivered", dispositionLabel: "Sent", taskId: null, taskIds: [], source: "user", actions: [] });
const descendants = (n: Element): Element[] => [n, ...n.children.flatMap(descendants)];

test("Requests keeps completed and active history visible in supplied order, preserving reading position", () => {
  const { c, list, count, jumps } = setup();
  c.rows.push(request("needs-you", "needs_you"), request("working", "in_flight"), request("finished", "settled", "done"));
  list.scrollTop = 147; c.renderLedger();
  expect(list.children.map(n => n.dataset.request)).toEqual(["needs-you", "working", "finished"]);
  expect(count.textContent).toBe("1"); expect(count.hidden).toBe(false);
  expect(list.scrollTop).toBe(147);
  const completed = list.children[2];
  expect(completed.className).toContain("settled");
  const check = descendants(completed).find(n => n.className === "completion-mark")!;
  expect(check.textContent).toBe("✓"); expect(check.attributes["aria-hidden"]).toBe("true");
  completed.children[0].handlers.click();
  expect(jumps[0].id).toBe("finished");
  c.rows[0] = request("needs-you", "settled", "done"); c.rows[1] = request("working", "settled", "done");
  c.renderLedger();
  expect(list.children).toHaveLength(3); expect(count.hidden).toBe(true);
  expect(list.scrollTop).toBe(147);
});

test("empty Requests explains the ledger, while settled history never becomes an empty-open view", () => {
  const { c, list, count } = setup(); c.renderLedger();
  expect(list.children).toHaveLength(1); expect(list.children[0].className).toBe("lg-empty");
  expect(list.children[0].textContent).toContain("Every message you send is a request");
  expect(count.hidden).toBe(true);
  c.rows.push(request("done", "settled", "done")); c.renderLedger();
  expect(list.children[0].dataset.request).toBe("done");
  expect(descendants(list).some(n => n.className === "lg-empty")).toBe(false);
});

test("Requests keeps the question and navigation, omits answer choices, and retains Retry actions", () => {
  const { c, list, jumps } = setup();
  const retries: string[] = []; let choicesDrawn = 0;
  const task = { id: "T-01", uuid: "agent-uuid", status: "wait", question: { q: "Which export format?", chips: ["JSON", "CSV"] } };
  c.S.tasks.set(task.id, task);
  c.inlineText = (node: Element, text: string) => { node.textContent = text; return node; };
  c.ttagBtn = (t: any, onClick: () => void) => { const b = new Element("button", "ttag", t.id); b.addEventListener("click", onClick); return b; };
  c.questionOption = (_t: any, choice: string) => { choicesDrawn++; return new Element("button", "question-option", choice); };
  c.relay = { redispatch: (id: string) => retries.push(id) };
  const row = { ...request("waiting", "needs_you", "wait"), taskId: task.id, taskIds: [task.id], answer: task.question.q, answerKind: "question", actions: ["answer", "redispatch"] };
  c.rows.push(row); c.renderLedger();
  const all = descendants(list);
  expect(choicesDrawn).toBe(0);
  expect(all.some(n => n.className === "question-option")).toBe(false);
  expect(all.find(n => n.className === "lg-ans question")?.textContent).toBe(task.question.q);
  list.children[0].children[0].handlers.click();
  expect(jumps[0]).toBe(row);
  const retry = all.find(n => n.tag === "button" && n.textContent === "Retry")!;
  expect(retry).toBeDefined(); retry.handlers.click(); expect(retries).toEqual(["waiting"]);
  // Removing the unrelated retry leaves a readable request, not an empty actions container.
  row.actions = ["answer"]; c.renderLedger();
  expect(descendants(list).some(n => n.className === "lg-acts")).toBe(false);
  expect(choicesDrawn).toBe(0);
});
