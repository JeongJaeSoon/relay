// Regression corpus for the dispatcher (design C.5): five single-decision cases that must never regress and five
// split cases. Each case replays its recorded `model_output` through the real Dispatcher and TaskService, so what is
// under test is the pipeline and the split guardrails — no `claude` process is ever spawned.
import { describe, expect, test } from "bun:test";
import { openDb, migrate } from "../../../src/db/db.ts";
import { EventLog, loadMessage, loadTask } from "../../../src/core/events.ts";
import { parseConfig } from "../../../src/config.ts";
import { PermitPool } from "../../../src/core/permits.ts";
import { Scheduler } from "../../../src/core/queue.ts";
import { Outbox } from "../../../src/lifecycle/outbox.ts";
import { FakeRunner } from "../../../src/runner/fake.ts";
import { TaskService } from "../../../src/core/tasks.ts";
import { Dispatcher, type RunClaude } from "../../../src/dispatcher/dispatcher.ts";
import { DecisionSchema, dispatchJsonSchema, lowConfidence, splitGuard } from "../../../src/dispatcher/schema.ts";
import { DISPATCH_SYSTEM_PROMPT, dispatchSystemPrompt } from "../../../src/dispatcher/system-prompt.ts";
import { ingestHook } from "../../../src/hooks/ingest.ts";
import { buildContext } from "../../../src/dispatcher/context.ts";
import { ulid } from "../../../src/core/ids.ts";
import corpus from "../../fixtures/dispatch-cases.json";

const world = corpus.world;
const stub = (obj: unknown): RunClaude => async () => ({ code: 0, stdout: JSON.stringify({ structured_output: obj, session_id: "x", duration_ms: 5, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 }), stderr: "" });
const settle = () => new Promise((r) => setTimeout(r, 40));

function setup(run: RunClaude, maxSplit = world.max_split) {
  const cfg = parseConfig(`max_concurrent_agents = 10\n[dispatcher]\ntimeout_ms = 500\nmax_split = ${maxSplit}\n`);
  const db = openDb(":memory:"); migrate(db); const log = new EventLog(db, () => {}, cfg);
  for (const p of world.projects) db.run("insert into projects(id,name,path,is_git,created_at) values(?,?,?,1,1)", [p.id, p.name, p.path]);
  const names = Object.fromEntries(world.projects.map((p) => [p.id, p.name]));
  const permits = new PermitPool(db, log, () => 10); const runner = new FakeRunner(); let svc!: TaskService;
  const outbox = new Outbox(db, log, runner, { delivery: () => "resume", isPaused: () => svc.paused(), settingsJson: () => "{}", env: () => ({}), socketPathFor: (r: any) => `/tmp/${r.pid}.sock`, instanceId: () => "inst" });
  const scheduler = new Scheduler(db, log, permits, (t) => svc.startSlot(t), () => svc.paused());
  svc = new TaskService({ db, log, cfg, permits, scheduler, outbox, projectNameOf: (id) => names[id] ?? id, pendingPermissions: new Map() });
  const confirms: string[] = [];
  const d = new Dispatcher(db, log, cfg, { runClaude: run, onDecision: (m, dec, patch) => svc.applyDecision(m, dec, patch), onNeedsConfirm: (m, dec, reason) => { confirms.push(reason); svc.needsConfirm(m, dec, reason); }, isPaused: () => false });
  const write = (text: string, state: string) => { const id = ulid(); log.emit({ type: "message.received", payload: { id, role: "user", source: "user", client_message_id: id, dispatch_state: state, text, task_uuid: null, reply_to_task_uuid: null, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: Date.now() } }); return loadMessage(db, id)!; };
  const say = (text: string) => { const m = write(text, "pending"); d.enqueue(m.id); return m.id; };
  return { db, log, cfg, svc, d, runner, outbox, write, say, confirms };
}

/** The world's one existing task: T-01, running, in the relay project. */
async function seed(s: ReturnType<typeof setup>) {
  const w = world.tasks[0];
  s.svc.applyDecision(s.write(w.title, "direct"), { action: "new_task", project: w.project, title: w.title, size: "normal", prompt: w.title, confidence: "high" });
  await settle();
  const t = s.db.query("select uuid, short_id from tasks where display_id='T-01'").get() as any;
  const row = [...s.runner.rows.values()].find((r: any) => r.short_id === t.short_id)!;
  ingestHook({ hook_event_name: "SessionStart", source: "startup", session_id: row.session_id, transcript_path: "/t", cwd: row.cwd }, { "x-relay-task": t.uuid }, s.svc.ingestDeps);
  expect(loadTask(s.db, t.uuid)!.status).toBe("running");
}

const rows = (db: any, sql: string) => (db.query(sql).all() as any[]).map((r) => r.display_id);
const created = (db: any) => rows(db, "select display_id from tasks where display_id<>'T-01' order by num");
const routed = (db: any) => rows(db, "select distinct t.display_id from commands c join tasks t on t.uuid=c.task_uuid where c.kind='send' order by t.num");

describe("dispatch corpus", () => {
  for (const c of corpus.cases) {
    test(c.name, async () => {
      const s = setup(stub(c.model_output));
      await seed(s);
      const id = s.say(c.message);
      await settle();

      const m = loadMessage(s.db, id)!;
      expect(m.dispatch_state as string).toBe(c.expect.dispatch_state);
      expect(created(s.db)).toEqual(c.expect.created);
      expect(routed(s.db)).toEqual(c.expect.routed);

      if (c.expect.dispatch_state === "needs_confirm") {
        expect((s.db.query("select count(*) c from messages where role='system' and text like 'Routing needs confirmation%'").get() as any).c).toBe(1);
        return;
      }
      const badge = (s.db.query("select text from messages where text like 'dispatcher · %' order by rowid desc limit 1").get() as any).text;
      expect(badge).toBe(c.expect.badge);
      if (c.expect.action === "split") {
        const ids = m.dispatch_json!.task_ids!;
        expect(badge.endsWith(ids.join(" "))).toBe(true);                                   // the badge names exactly what the message records
        expect(ids.length).toBe(c.expect.created.length + c.expect.routed.length);
        expect(m.task_uuid).toBe((s.db.query("select uuid from tasks where display_id=?").get(ids[0]) as any).uuid);   // C.4.4: first task on the message, full list in dispatch_json
      }
    });
  }

  // NOT an accuracy test: the model is stubbed, so this shows the five single-decision paths still carry a recorded
  // decision through to the same action. Whether a live model still PRODUCES those decisions is unmeasured here.
  test("replay: every single-decision case still reaches its recorded action", async () => {
    const singles = corpus.cases.filter((c) => c.kind === "single");
    expect(singles.length).toBe(5);
    for (const c of singles) {
      const s = setup(stub(c.model_output)); await seed(s);
      const id = s.say(c.message); await settle();
      const m = loadMessage(s.db, id)!;
      expect([c.name, m.dispatch_state, m.dispatch_json?.action ?? null]).toEqual([c.name, c.expect.dispatch_state, c.model_output.action]);
    }
  });

  test("max_split = 1 is the off switch: a two-item split never dispatches", async () => {
    const c = corpus.cases.find((x) => x.name.startsWith("split/mixed projects"))!;
    const s = setup(stub(c.model_output), 1); await seed(s);
    const id = s.say(c.message); await settle();
    expect(loadMessage(s.db, id)!.dispatch_state as string).toBe("needs_confirm");
    expect(created(s.db)).toEqual([]);
    expect(s.runner.calls.filter((x: any) => x.kind === "spawn").length).toBe(1);            // only the seed task ever spawned
  });

  // The scenario the splitting rule is meant to prevent but reads as permitted: a long-running same-repo task plus a
  // hotfix that "ships on its own PR" and has a wildly different lifetime — two live worktrees on one repository.
  const hotfix = (project: string) => ({ action: "split", confidence: "high", items: [
    { action: "route_to_task", task_id: "T-01", prompt: "keep going" },
    { action: "new_task", project, title: "hotfix", size: "small", prompt: "ship the one-line hotfix as its own PR" },
  ] });

  test("a follow-up plus new work in the SAME project is refused whole", async () => {
    const s = setup(stub(hotfix("relay"))); await seed(s);
    const id = s.say("T-01 은 계속 가고, 한 줄 핫픽스는 따로 PR 로 지금 올려줘"); await settle();
    expect(loadMessage(s.db, id)!.dispatch_state as string).toBe("needs_confirm");
    expect(created(s.db)).toEqual([]); expect(routed(s.db)).toEqual([]);
    const reason = (s.db.query("select text from messages where text like 'Routing needs confirmation%'").get() as any).text;
    expect(reason).toContain("same project (relay) as T-01");
    expect((s.db.query("select count(*) c from commands").get() as any).c).toBe(1);            // just the seed task's spawn
  });

  test("two new tasks in the same project are refused; the same pair across two projects still splits", async () => {
    const two = (a: string, b: string) => ({ action: "split", confidence: "high", items: [
      { action: "new_task", project: a, title: "one", size: "small", prompt: "one" },
      { action: "new_task", project: b, title: "two", size: "small", prompt: "two" },
    ] });
    const same = setup(stub(two("relay", "relay"))); await seed(same);
    const a = same.say("두 가지 다 해줘"); await settle();
    expect(loadMessage(same.db, a)!.dispatch_state as string).toBe("needs_confirm");
    expect(created(same.db)).toEqual([]);

    const apart = setup(stub(two("relay", "meterly"))); await seed(apart);
    const b = apart.say("두 가지 다 해줘"); await settle();
    expect(loadMessage(apart.db, b)!.dispatch_state as string).toBe("dispatched");
    expect(created(apart.db)).toEqual(["T-02", "T-03"]);
  });

  test("the same follow-up plus new work across two projects splits normally", async () => {
    const s = setup(stub(hotfix("meterly"))); await seed(s);
    const id = s.say("T-01 은 계속 가고, meterly 핫픽스는 따로 올려줘"); await settle();
    expect(loadMessage(s.db, id)!.dispatch_state as string).toBe("dispatched");
    expect(created(s.db)).toEqual(["T-02"]); expect(routed(s.db)).toEqual(["T-01"]);
  });

  test("the next decision's context names every task the split made, not a bare `split`", async () => {
    const c = corpus.cases.find((x) => x.name.startsWith("split/mixed projects"))!;
    const s = setup(stub(c.model_output)); await seed(s);
    s.say(c.message); await settle();
    const ctx = buildContext(s.db);
    expect(ctx).toContain("→ split T-02 T-03");                                              // a follow-up ("cancel that") can still resolve the targets
    expect(ctx).not.toContain("→ split\n");
  });

  test("an unknown project in one item aborts the whole split before anything is emitted", async () => {
    const s = setup(stub({ action: "split", confidence: "high", items: [
      { action: "new_task", project: "relay", title: "a", size: "small", prompt: "a" },
      { action: "new_task", project: "nope", title: "b", size: "small", prompt: "b" },
    ] })); await seed(s);
    const id = s.say("두 군데 고쳐줘"); await settle();
    expect(loadMessage(s.db, id)!.dispatch_state as string).toBe("needs_confirm");
    expect(created(s.db)).toEqual([]);
    expect((s.db.query("select count(*) c from messages where text like 'dispatcher · split%'").get() as any).c).toBe(0);
  });
});

describe("split guardrails", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ action: "new_task" as const, project: "relay", title: `t${i}`, size: "small" as const, prompt: "p" }));
  const dec = (extra: Record<string, unknown> = {}) => ({ action: "split", confidence: "high", items: items(2), ...extra }) as any;

  test("the cap, an unsure item and a missing prompt each refuse the whole split", () => {
    expect(splitGuard(dec(), 4)).toBeNull();
    expect(splitGuard(dec({ items: items(5) }), 4)).toContain("exceeds dispatcher.max_split = 4");
    expect(splitGuard(dec(), 1)).toContain("max_split = 1");
    expect(splitGuard(dec({ confidence: "low" }), 4)).toContain("confidence=low");
    expect(splitGuard(dec({ items: [...items(1), { action: "new_task", project: "relay", title: "x", size: "small", prompt: "p", confidence: "low" }] }), 4)).toContain("confidence=low");
    expect(splitGuard(dec({ items: [{ action: "new_task", project: "relay", title: "x", size: "small" }] }), 4)).toContain("prompt required");
    expect(splitGuard(dec({ items: [{ action: "route_to_task", prompt: "p" }] }), 4)).toContain("route_to_task needs task_id");
  });

  test("lowConfidence covers the message and every item", () => {
    expect(lowConfidence(dec())).toBe(false);
    expect(lowConfidence(dec({ confidence: "low" }))).toBe(true);
    expect(lowConfidence(dec({ items: [{ action: "new_task", project: "relay", title: "x", size: "small", prompt: "p", confidence: "low" }] }))).toBe(true);
  });

  test("max_split = 1 removes split from the model's schema and the prompt; the measured wording is untouched", () => {
    const off = dispatchJsonSchema(1) as any, on = dispatchJsonSchema(4) as any;
    expect(off.properties.action.enum).not.toContain("split");
    expect(off.properties.items).toBeUndefined();
    expect(on.properties.action.enum).toContain("split");
    expect(on.properties.items.maxItems).toBe(4);
    expect(dispatchSystemPrompt(1)).toBe(DISPATCH_SYSTEM_PROMPT);
    expect(dispatchSystemPrompt(4).startsWith(DISPATCH_SYSTEM_PROMPT)).toBe(true);              // appended clause only (C.5)
    expect(dispatchSystemPrompt(4)).toContain("at most 4");
  });

  test("the schema accepts a split and rejects a nested or empty one", () => {
    expect(DecisionSchema.safeParse(dec()).success).toBe(true);
    expect(DecisionSchema.safeParse(dec({ items: [] })).success).toBe(false);
    expect(DecisionSchema.safeParse(dec({ items: [{ action: "split", prompt: "p" }] })).success).toBe(false);
    expect(DecisionSchema.safeParse(dec({ items: [{ action: "answer_directly", prompt: "p" }] })).success).toBe(false);
    expect(DecisionSchema.safeParse({ action: "new_task", project: "relay", title: "t", size: "small", confidence: "high" }).success).toBe(true);
  });
});
