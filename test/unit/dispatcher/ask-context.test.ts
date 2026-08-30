import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../../../src/db/db.ts";
import { buildAskContext, transcriptDigest, transcriptPathFor, TRANSCRIPT_BUDGET, TRANSCRIPT_TAIL_BYTES } from "../../../src/dispatcher/ask-context.ts";

const line = (type: string, content: unknown) => JSON.stringify({ type, message: { role: type, content } }) + "\n";
function setup() {
  const db = openDb(":memory:"); migrate(db);
  db.run("insert into projects(id,name,path,created_at) values('p1','myapp','/tmp/myapp',1)");
  const task = (uuid: string, num: number, extra: Record<string, unknown> = {}) => {
    const cols = { uuid, num, display_id: `T-0${num}`, project_id: "p1", title: "auth refactor", status: "running", size: "normal", effort: "xhigh", model: "claude-opus-5", process_generation: 1, created_at: 1, updated_at: 1, ...extra };
    db.run(`insert into tasks(${Object.keys(cols).join(",")}) values(${Object.keys(cols).map(() => "?").join(",")})`, Object.values(cols) as any);
  };
  const hook = (uuid: string, body: unknown) => db.run("insert into events(event_id,type,task_uuid,occurred_at,recorded_at,payload_json) values(?,?,?,1,1,?)", [crypto.randomUUID(), "hook.PostToolUse", uuid, JSON.stringify(body)]);
  const dir = mkdtempSync(join(tmpdir(), "relay-ask-"));
  return { db, task, hook, dir };
}

describe("what an Ask may read", () => {
  test("only a transcript_path the CLI gave relay for THIS task", () => {
    const s = setup(); s.task("u1", 1); s.task("u2", 2);
    expect(transcriptPathFor(s.db, "u1")).toBeNull();                                  // relay was given nothing yet
    s.hook("u2", { tool_name: "Bash", transcript_path: "/other/task.jsonl" });
    expect(transcriptPathFor(s.db, "u1")).toBeNull();                                  // another task's transcript is not ours to read
    s.hook("u1", { tool_name: "Read", transcript_path: "/mine/old.jsonl" });
    s.hook("u1", { tool_name: "Edit", transcript_path: "/mine/current.jsonl" });
    expect(transcriptPathFor(s.db, "u1")).toBe("/mine/current.jsonl");                 // the newest path the CLI handed us
    expect(transcriptPathFor(s.db, "u2")).toBe("/other/task.jsonl");
  });
  test("a hook event without a transcript_path never contributes one", () => {
    const s = setup(); s.task("u1", 1);
    s.hook("u1", { tool_name: "Read", transcript_path: "/mine/current.jsonl" });
    s.hook("u1", { tool_name: "Edit" });                                               // newer, but carries no path
    expect(transcriptPathFor(s.db, "u1")).toBe("/mine/current.jsonl");
  });
  test("a missing or unreadable path yields nothing, never a throw", () => {
    expect(transcriptDigest(null)).toBe("");
    expect(transcriptDigest("/no/such/transcript.jsonl")).toBe("");
  });
});

describe("the transcript slice is bounded", () => {
  test("a megabyte of transcript is digested down to the budget, keeping the tail", () => {
    const s = setup(); const path = join(s.dir, "big.jsonl");
    let body = "";
    for (let i = 0; i < 4000; i++) body += line("assistant", [{ type: "text", text: `step ${i} ${"x".repeat(300)}` }]);
    writeFileSync(path, body);
    expect(body.length).toBeGreaterThan(1_000_000);
    const d = transcriptDigest(path);
    expect(d.length).toBeLessThanOrEqual(TRANSCRIPT_BUDGET);
    expect(d).toContain("step 3999");                                                  // the tail, not the head
    expect(d).not.toContain("step 0 ");
  });
  test("records become legible lines: text, tool calls, tool results", () => {
    const s = setup(); const path = join(s.dir, "small.jsonl");
    writeFileSync(path, line("user", "why is the build red") + line("assistant", [{ type: "text", text: "checking" }, { type: "tool_use", name: "Bash", input: { command: "bun test" } }]) + line("user", [{ type: "tool_result", content: "2 failed" }]) + "half a record without a newl");
    const d = transcriptDigest(path);
    expect(d).toContain("user: why is the build red");
    expect(d).toContain("assistant: checking | → Bash bun test");
    expect(d).toContain("← 2 failed");
  });
  test("a tail that starts mid-record drops the broken first line", () => {
    const s = setup(); const path = join(s.dir, "tail.jsonl");
    writeFileSync(path, "x".repeat(TRANSCRIPT_TAIL_BYTES) + "\n" + line("assistant", [{ type: "text", text: "the end" }]));
    expect(transcriptDigest(path)).toBe("assistant: the end");
  });
});

describe("the task context", () => {
  test("carries the state relay already holds plus the transcript tail", () => {
    const s = setup(); const path = join(s.dir, "t.jsonl");
    writeFileSync(path, line("assistant", [{ type: "text", text: "retrying the migration" }]));
    s.task("u1", 2, { status: "running", last_step: "Bash bun test", last_summary: "split auth into 3 modules", started_at: 1, usage_tokens: 4200 });
    s.hook("u1", { tool_name: "Bash", transcript_path: path });
    const ctx = buildAskContext(s.db, "u1");
    expect(ctx).toContain('[task T-02] "auth refactor" project=myapp status=running');
    expect(ctx).toContain("last step: Bash bun test");
    expect(ctx).toContain("last summary: split auth into 3 modules");
    expect(ctx).toContain("- PostToolUse · Bash");
    expect(ctx).toContain("retrying the migration");
  });
  test("a task relay was given no transcript for says so instead of looking elsewhere", () => {
    const s = setup(); s.task("u1", 1);
    expect(buildAskContext(s.db, "u1")).toContain("relay was given no transcript for this task");
  });
});
