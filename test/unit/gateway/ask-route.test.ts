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
  test("ask_task_id scopes the question to a task without answering it", async () => {
    const s = await buildTestApp(); const uuid = s.seedTask("running");
    const id = await post(s.req, { text: "why is it stuck", ask_task_id: uuid, client_message_id: "s1" }); await s.settle(120);
    const m = s.db.query("select * from messages where id=?").get(id) as any;
    expect(m.text).toBe(`${ASK_PREFIX}why is it stuck`);
    expect(m.task_uuid).toBe(uuid);                                        // the target survives a restart
    expect(m.reply_to_task_uuid).toBeNull();                               // not a reply: nothing is delivered to the worker
    expect(m.dispatch_state).toBe("dispatched");                           // it went through the dispatcher, not into the task
    expect(JSON.parse(m.dispatch_json).action).toBe("answer_directly");
  });
  test("ask_task_id is validated, and cannot be combined with reply_to_task_id", async () => {
    const { req, seedTask } = await buildTestApp(); const uuid = seedTask("running");
    expect((await req("POST", "/api/messages", { text: "x", ask_task_id: "nope" })).status).toBe(404);
    expect((await req("POST", "/api/messages", { text: "x", ask_task_id: uuid, reply_to_task_id: uuid })).status).toBe(400);
  });
  test("asking about a task queues no command for it", async () => {
    const s = await buildTestApp(decide({ action: "route_to_task", task_id: "T-01", prompt: "p", confidence: "high" }));
    const uuid = s.seedTask("running"); const before = (s.db.query("select count(*) c from commands where task_uuid=?").get(uuid) as any).c;
    await post(s.req, { text: "why is it stuck", ask_task_id: uuid, client_message_id: "s2" }); await s.settle(120);
    expect(s.db.query("select count(*) c from commands where task_uuid=?").get(uuid)).toEqual({ c: before });
  });
  test("the ? prefix is a keyboard gesture: only a person typing gets it", async () => {
    const { req, db } = await buildTestApp();
    const gh = await post(req, { text: "? why does the build fail", source: "github", client_message_id: "g1" });
    expect((db.query("select text from messages where id=?").get(gh) as any).text).toBe("? why does the build fail");   // stored verbatim, dispatched as work
    const cli = await post(req, { text: "? why does the build fail", source: "cli", client_message_id: "g2" });
    expect((db.query("select text from messages where id=?").get(cli) as any).text).toBe(`${ASK_PREFIX}why does the build fail`);
    const declared = await post(req, { text: "why does the build fail", ask: true, source: "github", client_message_id: "g3" });
    expect((db.query("select text from messages where id=?").get(declared) as any).text).toBe(`${ASK_PREFIX}why does the build fail`);   // an explicit declaration works from anywhere
  });
  test("a bare ? is not a question", async () => {
    const { req } = await buildTestApp();
    expect((await req("POST", "/api/messages", { text: "?" })).status).toBe(400);
    expect((await req("POST", "/api/messages", { text: " ", ask: true })).status).toBe(400);
  });
});
