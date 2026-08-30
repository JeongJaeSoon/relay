import { describe, expect, test } from "bun:test";
import { openDb, migrate } from "../../../src/db/db.ts";
import { EventLog, loadTask } from "../../../src/core/events.ts";
import { parseConfig } from "../../../src/config.ts";
import { FakeRunner } from "../../../src/runner/fake.ts";
import { Outbox, readOwner } from "../../../src/lifecycle/outbox.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";

const cfg = parseConfig("");
/** Stand in for ~/.claude/jobs/<short>/state.json, the only place the CLI exposes a session's worktree path. */
function jobsDir(map: Record<string, string>) {
  const base = mkdtempSync(join(tmpdir(), "relay-jobs-"));
  for (const [short, worktreePath] of Object.entries(map)) { mkdirSync(join(base, short), { recursive: true }); writeFileSync(join(base, short, "state.json"), JSON.stringify({ worktreePath })); }
  const saved = process.env.RELAY_CLAUDE_JOBS_DIR; process.env.RELAY_CLAUDE_JOBS_DIR = base;
  return { restore: () => { if (saved === undefined) delete process.env.RELAY_CLAUDE_JOBS_DIR; else process.env.RELAY_CLAUDE_JOBS_DIR = saved; } };
}
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
  test("spawn adopts an already-running session only when its WORKTREE carries our owner stamp (crash between exec and record)", async () => {
    const s = setup(); s.mk("u1", "starting");
    // `agents --json` reports the launch cwd (the project root); the worktree lives in ~/.claude/jobs/<short>/state.json
    const wt = mkdtempSync(join(tmpdir(), "relay-wt-")); writeFileSync(join(wt, ".relay-owner"), JSON.stringify({ relay_instance_id: "inst", task_uuid: "u1", session_id: "sid" }));
    const jobs = jobsDir({ pre: wt });
    s.runner.rows.set("pre", { short_id: "pre", session_id: "sid", name: "relay:T-01 t", cwd: "/p", pid: 5, alive: true, busy: true, waiting_for: null, raw: {} });
    s.ob.enqueue("u1", "k", { kind: "spawn", spec: spec("u1") }); await s.ob.run("u1");
    jobs.restore();
    expect(s.runner.calls.length).toBe(0); expect(loadTask(s.db, "u1")!.short_id).toBe("pre"); expect(loadTask(s.db, "u1")!.session_id).toBe("sid"); expect(loadTask(s.db, "u1")!.worktree_path).toBe(wt);
  });
  test("a stamp in the LAUNCH cwd never adopts a git-project session — that directory is shared by every task in the project", async () => {
    const s = setup(); s.mk("u1", "starting");
    const launch = mkdtempSync(join(tmpdir(), "relay-proj-")); writeFileSync(join(launch, ".relay-owner"), JSON.stringify({ relay_instance_id: "inst", task_uuid: "u1", session_id: "sid" }));
    s.runner.rows.set("pre", { short_id: "pre", session_id: "sid", name: "relay:T-01 t", cwd: launch, pid: 5, alive: true, busy: true, waiting_for: null, raw: {} });
    s.ob.enqueue("u1", "k", { kind: "spawn", spec: spec("u1") }); await s.ob.run("u1");
    expect(s.runner.calls.filter((c) => c.kind === "spawn").length).toBe(1);       // not adopted
    expect(loadTask(s.db, "u1")!.worktree_path).toBeNull();                        // stamp deferred to the first hook
  });
  test("a non-git task stamps its launch cwd, which is its working directory", async () => {
    const s = setup(); s.mk("u1", "starting");
    const dir = mkdtempSync(join(tmpdir(), "relay-nogit-"));
    s.ob.enqueue("u1", "k", { kind: "spawn", spec: { ...spec("u1"), worktree: null, cwd: dir } }); await s.ob.run("u1");
    const row = [...s.runner.rows.values()].find((r) => r.short_id === "fake1")!;
    expect(readOwner(dir)).toMatchObject({ task_uuid: "u1", session_id: row.session_id }); expect(loadTask(s.db, "u1")!.worktree_path).toBe(dir);
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
  test("a socket send is never optimistically accepted; the marker echo promotes it, refused fails, held stays pending", async () => {
    // idle worker: a send to a busy one is held at the turn boundary (see the busy test below). There is no ack frame,
    // so nothing here may report `accepted` on its own.
    const s = setup("socket"); s.mk("u1", "running", { session_id: "sid", short_id: "fake1", process_state: "alive", turn_state: "idle" }); s.live("u1", "fake1", false);
    let outcome: any = "accepted"; let sent = 0; (s.runner as any).sendSocket = async () => { sent++; return outcome; };
    s.ob.enqueue("u1", "a", { kind: "send", text: "a", marker: "0000000a" }); await s.ob.run("u1");
    expect(sent).toBe(1); expect(s.states()).toEqual(["unknown"]);                                    // delivered mid-turn, but unproven → unknown, not applied
    expect(s.db.query("select json_extract(payload_json,'$.outcome') o from events where type='send.outcome'").all()).toEqual([{ o: "unknown" }]);
    s.ob.markAccepted("u1", "0000000a"); expect(s.states()).toEqual(["applied"]);                     // the `[relay #…]` echo is the only proof
    outcome = "held"; s.ob.enqueue("u1", "b", { kind: "send", text: "b", marker: "0000000b" }); s.ob.enqueue("u1", "c", { kind: "send", text: "c", marker: "0000000c" }); await s.ob.run("u1");
    expect(s.states()).toEqual(["applied", "pending", "pending"]);                                    // held: b stays at the head, c waits behind it (I8)
    outcome = "refused"; await s.ob.run("u1"); expect(s.states()).toEqual(["applied", "failed", "failed"]);   // a refusal is final: the queue drains past it
    outcome = "unknown"; s.ob.enqueue("u1", "d", { kind: "send", text: "d", marker: "0000000d" }); s.ob.enqueue("u1", "e", { kind: "send", text: "e", marker: "0000000e" }); await s.ob.run("u1");
    expect(s.states().slice(-2)).toEqual(["unknown", "pending"]);                                     // an unknown head blocks its queue until promoted or confirmed
  });
  test("a socket send to a BUSY worker goes straight through; only the resume path waits for the turn boundary", async () => {
    // Phase 0 ②: a frame sent mid-turn is read between tool calls (acked 22.8s into a turn whose Stop came at 86.6s).
    const s = setup("socket"); s.mk("u1", "running", { session_id: "sid", short_id: "fake1", process_state: "alive", turn_state: "busy" }); s.live("u1", "fake1", true);
    let sent = 0; (s.runner as any).sendSocket = async () => { sent++; return "accepted"; };
    s.ob.enqueue("u1", "a", { kind: "send", text: "a", marker: "0000000a" }); await s.ob.run("u1");
    expect(sent).toBe(1); expect(s.states()).toEqual(["unknown"]);                                    // delivered mid-turn, unproven until the marker echo
    expect(s.db.query("select json_extract(payload_json,'$.outcome') o from events where type='send.outcome'").all()).toEqual([{ o: "unknown" }]);
    s.ob.markAccepted("u1", "0000000a"); expect(s.states()).toEqual(["applied"]);

    // The resume path still waits: it stops and restarts the session, so running it mid-turn would cut the turn.
    const r = setup("resume"); r.mk("u2", "running", { session_id: "sid2", short_id: "fake2", process_state: "alive", turn_state: "busy" }); r.live("u2", "fake2", true);
    r.ob.enqueue("u2", "b", { kind: "send", text: "b", marker: "0000000b" }); await r.ob.run("u2");
    expect(r.states()).toEqual(["pending"]);
    r.log.emit({ type: "task.patched", task_uuid: "u2", payload: { patch: { turn_state: "idle" } } });   // Stop hook
    await r.ob.run("u2"); expect(r.states()).not.toEqual(["pending"]);
  });
  test("promoteFromTranscript clears a send that fired no UserPromptSubmit hook", async () => {
    const s = setup("socket"); s.mk("u1", "running", { session_id: "sid", short_id: "fake1", process_state: "alive", turn_state: "idle" }); s.live("u1", "fake1", false);
    (s.runner as any).sendSocket = async () => "accepted";
    s.ob.enqueue("u1", "a", { kind: "send", text: "a", marker: "0000abcd" }); await s.ob.run("u1"); expect(s.states()).toEqual(["unknown"]);
    const f = join(mkdtempSync(join(tmpdir(), "relay-tx-")), "t.jsonl");
    writeFileSync(f, JSON.stringify({ type: "user", message: { content: "<cross-session-message from=\"uds:/tmp/x.sock\">\n[relay #0000abcd] a\n</cross-session-message>" } }) + "\n");
    expect(s.ob.promoteFromTranscript("u1", f)).toBe(1); expect(s.states()).toEqual(["applied"]);
    expect(s.ob.promoteFromTranscript("u1", f)).toBe(0);                                              // nothing left to promote
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
