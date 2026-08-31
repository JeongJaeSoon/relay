import { describe, expect, test } from "bun:test";
import { buildTestApp, decide } from "../../helpers/app.ts";

const rowOf = (db: any, id: string) => db.query("select * from messages where id=?").get(id) as any;
const textOf = (db: any, id: string) => rowOf(db, id).text;
const post = async (req: any, body: unknown) => ((await (await req("POST", "/api/messages", body)).json()) as any).message_id as string;

describe("Ask mode — POST /api/messages", () => {
  test("the toggle and the ? prefix store the same canonical message", async () => {
    const { req, db } = await buildTestApp();
    const a = await post(req, { text: "why did T-02 fail", ask: true, client_message_id: "c1" });
    const b = await post(req, { text: "? why did T-02 fail", client_message_id: "c2" });
    expect(rowOf(db, a)).toMatchObject({ text: "why did T-02 fail", ask: 1 });   // the gesture is stripped; the declaration is the column
    expect(rowOf(db, b)).toMatchObject({ text: "why did T-02 fail", ask: 1 });
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
    expect(rowOf(db, id)).toMatchObject({ text: "a", ask: 0 });
  });
  test("ask_task_id scopes the question to a task without answering it", async () => {
    const s = await buildTestApp(); const uuid = s.seedTask("running");
    const id = await post(s.req, { text: "why is it stuck", ask_task_id: uuid, client_message_id: "s1" }); await s.settle(120);
    const m = s.db.query("select * from messages where id=?").get(id) as any;
    expect(m.text).toBe("why is it stuck"); expect(m.ask).toBe(1);
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
  // The rule this pins is what dispatch DID with the message, not just what was stored: the intent travels as
  // `messages.ask`, so a body that merely starts with `?` cannot become a question anywhere downstream.
  test("a ? body from a non-typing source is work: stored verbatim AND routed as work", async () => {
    const s = await buildTestApp(decide({ action: "new_task", project: "myapp", title: "auth", size: "normal", prompt: "p", confidence: "high" }));
    for (const source of ["github", "slack", "cron", "mcp"] as const) {
      const id = await post(s.req, { text: "? please fix the parser", source, client_message_id: `w-${source}` }); await s.settle(120);
      const m = rowOf(s.db, id);
      expect(m).toMatchObject({ text: "? please fix the parser", ask: 0, dispatch_state: "dispatched" });   // verbatim, and never a question
      expect(JSON.parse(m.dispatch_json).action).toBe("new_task");
    }
    expect(s.db.query("select count(*) c from tasks").get()).toEqual({ c: 4 });   // the work reached the routing path from every source
  });
  test("a declared question is answered, from a typed ? or an explicit ask on any source", async () => {
    const s = await buildTestApp(decide({ answer: "the parser build is fine." }));
    const cli = await post(s.req, { text: "? why does the build fail", source: "cli", client_message_id: "g2" });
    const declared = await post(s.req, { text: "why does the build fail", ask: true, source: "github", client_message_id: "g3" });
    await s.settle(150);
    for (const id of [cli, declared]) {
      const m = rowOf(s.db, id);
      expect(m).toMatchObject({ text: "why does the build fail", ask: 1, dispatch_state: "dispatched" });   // an explicit declaration works from anywhere
      expect(JSON.parse(m.dispatch_json).action).toBe("answer_directly");
    }
    expect(s.db.query("select count(*) c from tasks").get()).toEqual({ c: 0 });
  });
  test("a bare ? is not a question", async () => {
    const { req } = await buildTestApp();
    expect((await req("POST", "/api/messages", { text: "?" })).status).toBe(400);
    expect((await req("POST", "/api/messages", { text: " ", ask: true })).status).toBe(400);
  });
});
