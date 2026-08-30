import { describe, expect, test } from "bun:test";
import { openDb, migrate } from "../../../src/db/db.ts";
import { EventLog, loadTask } from "../../../src/core/events.ts";
import { parseConfig } from "../../../src/config.ts";
import { FakeRunner } from "../../../src/runner/fake.ts";
import { Outbox } from "../../../src/lifecycle/outbox.ts";
import { mkdtempSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";

const cfg = parseConfig("");
const spec = (uuid: string) => ({ taskUuid: uuid, displayId: "T-01", name: "relay:T-01 t", cwd: "/p", worktree: "relay-abc", model: "m", effort: "xhigh" as const, permissionMode: "auto", advisor: null, agent: "relay-worker", settingsJson: "{}", prompt: "[relay #00000001] T-01\n\nhi", env: {} });
function setup(delivery: "socket" | "resume" = "resume") {
  const db = openDb(":memory:"); migrate(db); const log = new EventLog(db, () => {}, cfg); db.run("insert into projects(id,name,path,created_at) values('p','p','/p',1)");
  const runner = new FakeRunner(); let paused = false;
  const ob = new Outbox(db, log, runner, { delivery: () => delivery, isPaused: () => paused, settingsJson: () => "{}", env: () => ({}), socketPathFor: (r) => `/tmp/cc-socks/${r.pid}.sock`, instanceId: () => "inst" });
  const mk = (uuid: string, status: string, extra: Record<string, unknown> = {}) => log.emit({ type: "task.created", task_uuid: uuid, payload: { uuid, num: Number(uuid.slice(1)), display_id: "T-01", project_id: "p", title: "t", status, size: "normal", effort: "xhigh", model: "m", session_id: null, short_id: null, worktree_path: null, branch: null, base_sha: null, process_state: "none", process_generation: 0, turn_state: "idle", attach_state: "none", attached_by: null, paused: false, last_summary: null, last_step: null, question: null, parent_uuid: null, agent_id: null, agent_type: null, queued_at: null, qhead: false, started_at: 1, ended_at: null, created_at: 1, updated_at: 1, closed_at: null, usage_tokens: 0, ...extra } });
  const live = (uuid: string, short = "fake1", busy = false) => { runner.rows.set(short, { short_id: short, session_id: "sid", name: "n", cwd: "/p", pid: 9, alive: true, busy, waiting_for: null, raw: {} }); };
  const states = () => db.query("select state from commands order by rowid").all().map((r: any) => r.state);
  return { db, log, runner, ob, mk, live, states, setPaused: (v: boolean) => (paused = v) };
}
describe("Outbox", () => {
  test("spawn applies once, is idempotent by key, and only runs once the scheduler granted a slot (status=starting)", async () => {
    const s = setup(); s.mk("u1", "queued", { queued_at: 1 });
    s.ob.enqueue("u1", "msg1", { kind: "spawn", spec: spec("u1") }); s.ob.enqueue("u1", "msg1", { kind: "spawn", spec: spec("u1") }); await s.ob.run("u1");
    expect(s.runner.calls.length).toBe(0); expect(s.states()).toEqual(["pending"]);                  // queued: no slot yet
    s.log.emit({ type: "task.status_changed", task_uuid: "u1", payload: { status: "starting", patch: { status: "starting" } } }); await s.ob.run("u1");
    expect(s.runner.calls.filter((c) => c.kind === "spawn").length).toBe(1); expect(s.states()).toEqual(["applied"]); expect(loadTask(s.db, "u1")!.short_id).toBe("fake1");
  });
  test("spawn adopts an already-running session only when its cwd carries our owner stamp (crash between exec and record)", async () => {
    const s = setup(); s.mk("u1", "starting");
    const cwd = mkdtempSync(join(tmpdir(), "relay-wt-")); writeFileSync(join(cwd, ".relay-owner"), JSON.stringify({ relay_instance_id: "inst", task_uuid: "u1", session_id: "sid" }));
    s.runner.rows.set("pre", { short_id: "pre", session_id: "sid", name: "relay:T-01 t", cwd, pid: 5, alive: true, busy: true, waiting_for: null, raw: {} });
    s.ob.enqueue("u1", "k", { kind: "spawn", spec: spec("u1") }); await s.ob.run("u1");
    expect(s.runner.calls.length).toBe(0); expect(loadTask(s.db, "u1")!.short_id).toBe("pre"); expect(loadTask(s.db, "u1")!.session_id).toBe("sid");
  });
  test("a same-named session without our owner stamp is NOT adopted — a fresh spawn happens", async () => {
    const s = setup(); s.mk("u1", "starting"); s.runner.rows.set("pre", { short_id: "pre", session_id: "sid", name: "relay:T-01 t", cwd: "/p", pid: 5, alive: true, busy: true, waiting_for: null, raw: {} });
    s.ob.enqueue("u1", "k", { kind: "spawn", spec: spec("u1") }); await s.ob.run("u1");
    expect(s.runner.calls.filter((c) => c.kind === "spawn").length).toBe(1); expect(loadTask(s.db, "u1")!.short_id).toBe("fake1");
  });
  test("send via resume path: waits for the turn to end, then stops the process and resumes with the marker", async () => {
    const s = setup("resume"); s.mk("u1", "running", { session_id: "sid", short_id: "fake1", process_state: "alive", turn_state: "busy" }); s.live("u1");
    s.ob.enqueue("u1", "m2", { kind: "send", text: "테스트도 추가해", marker: "0000abcd", message_id: "m2" }); await s.ob.run("u1");
    expect(s.runner.calls.length).toBe(0); expect(s.states()).toEqual(["pending"]);                  // B1: never cut a running turn
    s.log.emit({ type: "task.patched", task_uuid: "u1", payload: { patch: { turn_state: "idle" } } }); await s.ob.run("u1");
    expect(s.runner.calls.map((c) => c.kind)).toEqual(["stop", "resume"]);
    expect((s.runner.calls[1].args as any).prompt).toBe("[relay #0000abcd] 테스트도 추가해");
    expect(loadTask(s.db, "u1")!.process_state).toBe("starting"); expect(s.states()).toEqual(["applied"]);
    expect(s.db.query("select json_extract(payload_json,'$.message_id') m from events where type='send.outcome'").get()).toEqual({ m: "m2" });
  });
  test("send is held while attached or paused, and while the task is queued", async () => {
    const s = setup(); s.mk("u1", "running", { attach_state: "leased" });
    s.ob.enqueue("u1", "m3", { kind: "send", text: "x", marker: "00000002" }); await s.ob.run("u1");
    expect(s.runner.calls.length).toBe(0); expect(s.states()).toEqual(["pending"]);
    s.mk("u2", "queued", { queued_at: 1 }); s.ob.enqueue("u2", "m4", { kind: "send", text: "y", marker: "00000003" }); await s.ob.run("u2"); expect(s.runner.calls.length).toBe(0);
    s.mk("u3", "running"); s.setPaused(true); s.ob.enqueue("u3", "m5", { kind: "send", text: "z", marker: "00000004" }); await s.ob.run("u3"); expect(s.runner.calls.length).toBe(0);
  });
  test("socket delivery: accepted applies; held stays pending and blocks the queue until the next run; refused fails; unknown blocks until confirmed", async () => {
    const s = setup("socket"); s.mk("u1", "running", { session_id: "sid", short_id: "fake1", process_state: "alive", turn_state: "busy" }); s.live("u1", "fake1", true);
    let outcome: any = "accepted"; (s.runner as any).sendSocket = async () => outcome;
    s.ob.enqueue("u1", "a", { kind: "send", text: "a", marker: "0000000a" }); await s.ob.run("u1"); expect(s.states()).toEqual(["applied"]);
    outcome = "held"; s.ob.enqueue("u1", "b", { kind: "send", text: "b", marker: "0000000b" }); s.ob.enqueue("u1", "c", { kind: "send", text: "c", marker: "0000000c" }); await s.ob.run("u1");
    expect(s.states()).toEqual(["applied", "pending", "pending"]);                                   // held: b stays at the head, c waits behind it (I8)
    outcome = "accepted"; await s.ob.run("u1"); expect(s.states()).toEqual(["applied", "applied", "applied"]);
    outcome = "refused"; s.ob.enqueue("u1", "d", { kind: "send", text: "d", marker: "0000000d" }); await s.ob.run("u1"); expect(s.states().at(-1)).toBe("failed");
    outcome = "unknown"; s.ob.enqueue("u1", "e", { kind: "send", text: "e", marker: "0000000e" }); s.ob.enqueue("u1", "f", { kind: "send", text: "f", marker: "0000000f" }); await s.ob.run("u1");
    expect(s.states().slice(-2)).toEqual(["unknown", "pending"]);                                     // unknown head blocks f
    outcome = "accepted"; s.ob.markAccepted("u1", "0000000e"); await s.ob.run("u1"); expect(s.states().slice(-2)).toEqual(["applied", "applied"]);
    expect(s.db.query("select count(*) c from events where type='send.outcome'").get()).toEqual({ c: 8 });
  });
  test("commands run in insertion order: stop then rm; stop waits for the process to disappear", async () => {
    const s = setup(); s.mk("u1", "running", { session_id: "sid", short_id: "fake1", process_state: "alive" }); s.live("u1");
    s.ob.enqueue("u1", "s", { kind: "stop", reason: "interrupt" }); s.ob.enqueue("u1", "r", { kind: "rm" }); await s.ob.run("u1");
    expect(s.runner.calls.map((c) => c.kind)).toEqual(["stop", "rm"]); expect(s.states()).toEqual(["applied", "applied"]);
    expect(loadTask(s.db, "u1")!.process_state).toBe("stopped");
  });
  test("cancelPending fails the listed kinds so a closed task never keeps a pending spawn/send", async () => {
    const s = setup(); s.mk("u1", "queued", { queued_at: 1 });
    s.ob.enqueue("u1", "sp", { kind: "spawn", spec: spec("u1") }); s.ob.enqueue("u1", "se", { kind: "send", text: "x", marker: "00000009" });
    s.ob.cancelPending("u1", ["spawn", "send", "resume"], "close"); s.ob.enqueue("u1", "rm", { kind: "rm" }); await s.ob.run("u1");
    expect(s.states()).toEqual(["failed", "failed", "applied"]); expect(s.runner.calls.map((c) => c.kind)).toEqual([]);   // rm without short_id is a no-op call
  });
  test("reconcileRunning: a spawn left `running` by a crash goes back to pending; anything else becomes unknown (blocks its queue)", () => {
    const s = setup(); s.mk("u1", "queued", { queued_at: 1 }); s.mk("u2", "running", { session_id: "sid", short_id: "x", process_state: "alive" });
    const a = s.ob.enqueue("u1", "k1", { kind: "spawn", spec: spec("u1") }); const b = s.ob.enqueue("u2", "k2", { kind: "send", text: "t", marker: "0000aaaa" });
    for (const c of [a, b]) s.log.emit({ type: "command.running", task_uuid: c.task_uuid, causation_id: c.id, payload: { id: c.id } });
    expect(s.ob.reconcileRunning()).toEqual({ requeued: [a.id], unknown: [b.id] }); expect(s.states()).toEqual(["pending", "unknown"]);
  });
  test("stop/rm jump the queue and run even while attached; a send waits for detach", async () => {
    const s = setup(); s.mk("u1", "running", { session_id: "sid", short_id: "fake1", process_state: "alive", attach_state: "leased", attached_by: "cli:1" }); s.live("u1");
    s.ob.enqueue("u1", "s", { kind: "send", text: "t", marker: "0000bbbb" }); s.ob.enqueue("u1", "k", { kind: "stop", reason: "kill switch" }); await s.ob.run("u1");
    expect(s.states()).toEqual(["pending", "applied"]); expect(s.runner.calls.map((c) => c.kind)).toEqual(["stop"]); expect(loadTask(s.db, "u1")!.process_state).toBe("stopped");
  });
});
