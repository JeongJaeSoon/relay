import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners: Record<string, () => void> = {};
  constructor(public tag: string, public className = "", public textContent = "") {}
  append(...nodes: Element[]) { this.children.push(...nodes); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, handler: () => void) { this.listeners[name] = handler; }
}

test("a question and all its answer options share one accessible card without changing answer payloads", () => {
  const messages = new Element("div"); const sent: any[] = [];
  const context: any = {
    msgs: messages,
    el: (tag: string, cls = "", text = "") => new Element(tag, cls, text),
    document: { createTextNode: (text: string) => new Element("#text", "", text) },
    messageSender: () => new Element("div", "m-sender", "Agent"),
    agentKey: (task: any) => task.uuid,
    answerQuestion: (...args: any[]) => sent.push(args),
    scrollChat() {},
  };
  const helpers = source.slice(source.indexOf("function inlineText("), source.indexOf("const pad="));
  const question = source.slice(source.indexOf("function chatQuestion("), source.indexOf("function jumpToRequest("));
  runInNewContext(helpers + question, context);
  const longOption = "JSON — `" + "LongIdentifier".repeat(30) + "` / 원본 문자열";
  const task = { id: "T-01", uuid: "agent-1", question: { key: "q1", q: "어떤 형식으로 내보낼까요?", chips: ["CSV", longOption] } };
  context.chatQuestion(task);
  const row = messages.children[0];
  expect(row.className).toBe("m-row m-question");
  expect(row.dataset.agent).toBe("agent-1");
  const [sender, card] = row.children;
  expect(sender.className).toBe("m-sender");
  expect(card.className).toBe("m-question-card");
  expect(card.attributes.role).toBe("group");
  const [body, options] = card.children;
  expect(body.className).toBe("m-sys");
  expect(options.className).toBe("m-chips");
  expect(options.dataset.task).toBe("T-01"); // cross-session answer acknowledgement still finds the native buttons
  expect(options.children.map(n => n.tag)).toEqual(["button", "button"]);
  options.children[1].listeners.click();
  expect(sent).toEqual([[task, longOption]]);
});
