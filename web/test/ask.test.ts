import { afterEach, expect, test } from "bun:test";
import { ASK_PREFIX, isAsk, markAsk, stripAsk } from "@shared/ask.ts";
import { sendMessage } from "../src/api.ts";
import { badgeParts, dlogEntry } from "../src/adapter.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const capture = () => {
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: string, init: any) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ message_id: "m" }), { status: 202 }); }) as any;
  return bodies;
};

test("the marker round-trips and is idempotent", () => {
  expect(isAsk("? why")).toBe(true); expect(isAsk("?why")).toBe(true); expect(isAsk("why?")).toBe(false);
  expect(stripAsk("?  why did T-02 fail")).toBe("why did T-02 fail");
  expect(markAsk("why")).toBe(`${ASK_PREFIX}why`); expect(markAsk(markAsk("why"))).toBe(markAsk("why"));
});

test("the ? prefix and the Ask toggle send the same request", async () => {
  const bodies = capture();
  await sendMessage("? why did T-02 fail");                                      // typed prefix, toggle off
  await sendMessage("why did T-02 fail", true);                                  // toggle on
  await sendMessage("why did T-02 fail");                                        // neither → an ordinary message
  const shape = (b: any) => ({ text: b.text, ask: b.ask });
  expect(shape(bodies[0])).toEqual({ text: "why did T-02 fail", ask: true });
  expect(shape(bodies[1])).toEqual(shape(bodies[0]));
  expect(shape(bodies[2])).toEqual({ text: "why did T-02 fail", ask: undefined });
});

test("a question is shown as its question text with an ask chip", () => {
  const m = (text: string, st = "dispatched"): any => ({ id: "m1", role: "user", source: "user", client_message_id: "c", dispatch_state: st, text, task_uuid: null, reply_to_task_uuid: null, dispatch_json: { action: "answer_directly", answer: "a" }, dispatch_error: null, chain_prev_id: null, created_at: 1 });
  const ctx = { projects: [], tasks: {} } as any;
  expect(badgeParts(m(`${ASK_PREFIX}why did T-02 fail`), ctx).parts).toEqual(["ask", "answer_directly"]);
  expect(badgeParts(m("refactor auth"), ctx).parts).toEqual(["answer_directly"]);
  expect(badgeParts(m(`${ASK_PREFIX}상태?`, "fastpath"), ctx).parts).toEqual(["ask", "fast-path"]);
  expect(dlogEntry(m(`${ASK_PREFIX}why did T-02 fail`), ctx).text).toBe("why did T-02 fail");
});
