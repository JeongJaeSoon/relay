import { describe, expect, test } from "bun:test";
import { ASK_PREFIX } from "@shared/ask.ts";
import { buildTestApp, decide } from "../../helpers/app.ts";

const textOf = (db: any, id: string) => (db.query("select text from messages where id=?").get(id) as any).text;
const post = async (req: any, body: unknown) => ((await (await req("POST", "/api/messages", body)).json()) as any).message_id as string;

describe("Ask mode — POST /api/messages", () => {
  test("the toggle and the ? prefix store the same canonical message", async () => {
    const { req, db } = await buildTestApp();
    const a = await post(req, { text: "why did T-02 fail", ask: true, client_message_id: "c1" });
    const b = await post(req, { text: "? why did T-02 fail", client_message_id: "c2" });
    expect(textOf(db, a)).toBe(`${ASK_PREFIX}why did T-02 fail`);
    expect(textOf(db, b)).toBe(textOf(db, a));
  });
  test("a question never reaches the routing path, even when the model keeps returning new_task", async () => {
    const s = await buildTestApp(decide({ action: "new_task", project: "myapp", title: "auth", size: "normal", prompt: "p", confidence: "high" }));
    const q = await post(s.req, { text: "refactor auth in myapp", ask: true, client_message_id: "q" }); await s.settle(120);
    expect(s.db.query("select count(*) c from tasks").get()).toEqual({ c: 0 });
    expect((s.db.query("select dispatch_state from messages where id=?").get(q) as any).dispatch_state).toBe("failed");
    await post(s.req, { text: "refactor auth in myapp", client_message_id: "w" }); await s.settle(120);     // same words, no ask → a task
    expect(s.db.query("select count(*) c from tasks").get()).toEqual({ c: 1 });
  });
  test("ask is ignored on a reply — the answer reaches the worker verbatim", async () => {
    const { req, db, seedTask } = await buildTestApp(); const uuid = seedTask("waiting_input", { turn_state: "idle", question: { text: "a or b?", options: ["a", "b"], asked_at: 1, source: "marker" } });
    const id = await post(req, { text: "a", ask: true, reply_to_task_id: uuid, client_message_id: "r" });
    expect(textOf(db, id)).toBe("a");
  });
  test("a bare ? is not a question", async () => {
    const { req } = await buildTestApp();
    expect((await req("POST", "/api/messages", { text: "?" })).status).toBe(400);
    expect((await req("POST", "/api/messages", { text: " ", ask: true })).status).toBe(400);
  });
});
