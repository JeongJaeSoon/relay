import { afterEach, expect, test } from "bun:test";
import { isAsk, stripAsk } from "@shared/ask.ts";
import { createMessageSender, sendMessage } from "../src/api.ts";
import { badgeParts } from "../src/adapter.ts";
import { requestRows } from "../src/ledger.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const capture = () => {
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: string, init: any) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ message_id: "m" }), { status: 202 }); }) as any;
  return bodies;
};

test("a lost acknowledgement retries the same request ID, while a successful repeat is new", async () => {
  const bodies: any[] = []; const sender = createMessageSender();
  globalThis.fetch = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) throw new Error("ack lost after server accepted");
    return new Response(JSON.stringify({ message_id: "m" }), { status: 202 });
  }) as any;
  await expect(sender("myapp refactor")).rejects.toThrow("ack lost");
  await sender("myapp refactor"); await sender("myapp refactor");
  expect(bodies[0].client_message_id).toBe(bodies[1].client_message_id);
  expect(bodies[2].client_message_id).not.toBe(bodies[1].client_message_id);
});

test("changing the failed draft's Ask scope allocates a new request ID", async () => {
  const bodies: any[] = []; const sender = createMessageSender();
  globalThis.fetch = (async (_url: string, init: any) => { bodies.push(JSON.parse(init.body)); throw new Error("offline"); }) as any;
  await expect(sender("why?", { askTask: "u1" })).rejects.toThrow();
  await expect(sender("why?", { askTask: "u2" })).rejects.toThrow();
  expect(bodies[0].client_message_id).not.toBe(bodies[1].client_message_id);
});

test("the ? gesture is recognised and stripped", () => {
  expect(isAsk("? why")).toBe(true); expect(isAsk("?why")).toBe(true); expect(isAsk("why?")).toBe(false);
  expect(stripAsk("?  why did T-02 fail")).toBe("why did T-02 fail");
  expect(stripAsk(stripAsk("? why"))).toBe("why");
});

test("the ? prefix and the Ask toggle send the same request", async () => {
  const bodies = capture();
  await sendMessage("? why did T-02 fail");                                      // typed prefix, toggle off
  await sendMessage("why did T-02 fail", { ask: true });                         // toggle on
  await sendMessage("why did T-02 fail");                                        // neither → an ordinary message
  const shape = (b: any) => ({ text: b.text, ask: b.ask, ask_task_id: b.ask_task_id });
  expect(shape(bodies[0])).toEqual({ text: "why did T-02 fail", ask: true, ask_task_id: undefined });
  expect(shape(bodies[1])).toEqual(shape(bodies[0]));
  expect(shape(bodies[2])).toEqual({ text: "why did T-02 fail", ask: undefined, ask_task_id: undefined });
});

test("the task panel's button scopes the question; a reply is never turned into one", async () => {
  const bodies = capture();
  await sendMessage("why is it stuck", { askTask: "uuid-2" });                   // "Ask about this task"
  await sendMessage("? why is it stuck", { askTask: "uuid-2" });                 // same, with the prefix typed too
  await sendMessage("a", { replyTo: "uuid-2", ask: true });                      // answering a worker's question stays a reply
  expect(bodies[0]).toMatchObject({ text: "why is it stuck", ask: true, ask_task_id: "uuid-2" });
  expect({ ...bodies[1], client_message_id: null }).toEqual({ ...bodies[0], client_message_id: null });
  expect(bodies[2]).toMatchObject({ text: "a", reply_to_task_id: "uuid-2" });
  expect(bodies[2].ask).toBeUndefined(); expect(bodies[2].ask_task_id).toBeUndefined();
});

test("the ask chip reads the declaration, not the text", () => {
  const m = (text: string, ask = false, st = "dispatched"): any => ({ id: "m1", role: "user", source: "user", client_message_id: "c", dispatch_state: st, text, task_uuid: null, reply_to_task_uuid: null, ask, dispatch_json: { action: "answer_directly", answer: "a" }, dispatch_error: null, chain_prev_id: null, created_at: 1 });
  const ctx = { projects: [], tasks: {} } as any;
  expect(badgeParts(m("why did T-02 fail", true), ctx).parts).toEqual(["ask", "answer_directly"]);
  expect(badgeParts(m("refactor auth"), ctx).parts).toEqual(["answer_directly"]);
  expect(badgeParts(m("상태?", true, "fastpath"), ctx).parts).toEqual(["ask", "fast-path"]);
  expect(badgeParts(m("? please fix the parser"), ctx).parts).toEqual(["answer_directly"]);   // a body that merely starts with ? is not a question
  // The rail that showed this is now the request ledger; a prefix left on an older row must not reach it...
  expect(requestRows([m("? why did T-02 fail", true)], {})[0].text).toBe("why did T-02 fail");
  // ...but a `?` body from a non-typing source is the request, and the reader must show what was actually sent.
  expect(requestRows([{ ...m("? please fix the parser"), source: "github" }], {})[0].text).toBe("? please fix the parser");
});
