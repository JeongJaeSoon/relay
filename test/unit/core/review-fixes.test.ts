// Regressions for defects the plan-02 Task 1-4 code shipped with (found in review of PR #1).
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, SCHEMA_VERSION } from "../../../src/db/db.ts";
import { EventLog } from "../../../src/core/events.ts";
import { capPayload, redact } from "../../../src/core/redact.ts";

const open = () => { const db = new Database(":memory:", { strict: true }); db.run("pragma foreign_keys = on"); migrate(db); return db; };
const task = (db: Database, uuid: string, gen: number) => {
  db.run("insert into projects(id,name,path,description,keywords_json,base_ref,is_git,created_at) values('p','myapp','/tmp/myapp','','[]','head',1,1)");
  db.run(`insert into tasks(uuid,num,display_id,project_id,title,status,size,effort,model,process_state,process_generation,turn_state,attach_state,paused,qhead,created_at,updated_at,usage_tokens)
          values(?,1,'T-01','p','t','running','normal','xhigh','claude-opus-5','alive',?,'busy','none',0,0,1,1,0)`, [uuid, gen]);
};

test("redaction keeps the payload a parseable JSON document", () => {
  // The patterns run over JSON.stringify output, so a greedy match must not eat the closing quote and the keys after it.
  const payload = { out: "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abcdefghijklmnop", note: "hello world", verdict: "done" };
  const { json } = capPayload(payload);
  const back = JSON.parse(json) as typeof payload;
  expect(back.note).toBe("hello world");
  expect(back.verdict).toBe("done");
  expect(back.out).toBe("[redacted:oauth]");

  const pem = { a: "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----", task_status: "done", summary: "important" };
  const parsed = JSON.parse(capPayload(pem).json) as typeof pem;
  expect(parsed.task_status).toBe("done");
  expect(parsed.summary).toBe("important");
  expect(parsed.a).toBe("[redacted:privatekey]");

  expect(redact("token=CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abcdefghijklmnop rest")).toBe("token=[redacted:oauth] rest");

  // The BEGIN and END markers land in different values: a match spanning them would delete every key in between.
  const split = { a: "-----BEGIN RSA PRIVATE KEY-----", task_status: "done", summary: "important", b: "-----END RSA PRIVATE KEY-----" };
  expect(JSON.parse(capPayload(split).json)).toEqual(split);
});

test("emit does not throw on an empty source_event_id (dedupe covers what the UNIQUE index covers)", () => {
  const db = open();
  const log = new EventLog(db);
  const input = { type: "hook.Stop", source_session_id: "s1", process_generation: 1, source_event_id: "", payload: {} };
  expect(log.emit(input)).not.toBeNull();
  expect(log.emit(input)).toBeNull();                                       // deduped, not a UNIQUE violation that rolls the batch back
  expect((db.query("select count(*) c from events").get() as any).c).toBe(1);
});

test("a late process.ended from a superseded generation does not stop the live process", () => {
  const db = open();
  const log = new EventLog(db);
  task(db, "u1", 1);
  log.emit({ type: "process.started", task_uuid: "u1", payload: { generation: 1, short_id: "a1" } });
  log.emit({ type: "process.ended", task_uuid: "u1", process_generation: 1, payload: { generation: 1, reason: "other" } });
  log.emit({ type: "process.started", task_uuid: "u1", payload: { generation: 2, short_id: "a2" } });
  log.emit({ type: "process.ended", task_uuid: "u1", process_generation: 1, payload: { generation: 1, reason: "other" } });

  const t = db.query("select process_state, process_generation from tasks where uuid='u1'").get() as any;
  expect(t.process_state).toBe("alive");
  expect(t.process_generation).toBe(2);
  expect((db.query("select count(*) c from process_instances where task_uuid='u1' and ended_at is null").get() as any).c).toBe(1);   // I4
});

test("enum columns reject values outside the shared type unions", () => {
  const db = open();
  const log = new EventLog(db);
  task(db, "u1", 1);
  for (const patch of [{ turn_state: "BOGUS" }, { attach_state: "BOGUS" }, { effort: "BOGUS" }])
    expect(() => log.emit({ type: "task.status_changed", task_uuid: "u1", payload: { patch } })).toThrow();
  const t = db.query("select turn_state, attach_state, effort from tasks where uuid='u1'").get() as any;
  expect(t).toEqual({ turn_state: "busy", attach_state: "none", effort: "xhigh" });
});

test("an event with no task broadcasts no task frame", () => {
  const db = open();
  const frames: any[] = [];
  const log = new EventLog(db, (f) => frames.push(...f));
  log.emit({ type: "task.status_changed", task_uuid: null, payload: {} });
  expect(frames.filter((f) => f.type === "task.updated")).toEqual([]);       // never `{ task: null }` on the wire
  expect((db.query("select count(*) c from events").get() as any).c).toBe(1); // still recorded
});

test("settings.changed cannot write meta keys the runtime owns", () => {
  const db = open();
  const log = new EventLog(db);
  log.emit({ type: "settings.changed", payload: { schema_version: 99, kill_switch: "1", max_concurrent_agents: 4 } });
  const meta = (k: string) => (db.query("select value from meta where key=?").get(k) as any)?.value ?? null;
  expect(meta("schema_version")).toBe(String(SCHEMA_VERSION));
  expect(meta("kill_switch")).toBeNull();
  expect(meta("max_concurrent_agents")).toBe("4");
  expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });   // still migratable
});
