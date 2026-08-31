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
    expect(s.runner.calls.filter((c) => c.kind === "spawn").length).toBe(0);       // not adopted — and not spawned over either
    // B8 is unchanged: a stamp in the shared launch cwd is not proof. What changed is what relay does about it — it
    // used to spawn anyway, which is two agents in one worktree when that row IS this task's own earlier attempt.
    expect(s.states()).toEqual(["unknown"]); expect(loadTask(s.db, "u1")!.status).toBe("error");
    expect(loadTask(s.db, "u1")!.worktree_path).toBeNull();                        // stamp deferred to the first hook
  });
  test("a non-git task stamps its launch cwd, which is its working directory", async () => {
    const s = setup(); s.mk("u1", "starting");
    const dir = mkdtempSync(join(tmpdir(), "relay-nogit-"));
    s.ob.enqueue("u1", "k", { kind: "spawn", spec: { ...spec("u1"), worktree: null, cwd: dir } }); await s.ob.run("u1");
    const row = [...s.runner.rows.values()].find((r) => r.short_id === "fake1")!;
    expect(readOwner(dir)).toMatchObject({ task_uuid: "u1", session_id: row.session_id }); expect(loadTask(s.db, "u1")!.worktree_path).toBe(dir);
  });
  test("a same-named session without our owner stamp is NOT adopted, and NOT spawned over either", async () => {
    // Without a stamp the row is ambiguous, not absent: relay cannot tell this task's own unreported session from a
    // stranger's. Spawning was the wrong half of that guess — `spec.worktree` comes from the task uuid, so a second
    // spawn lands in the same working tree and takes `tasks.short_id`, hiding the first from the watchdog.
    const s = setup(); s.mk("u1", "starting"); s.runner.rows.set("pre", { short_id: "pre", session_id: "sid", name: "relay:T-01 t", cwd: "/p", pid: 5, alive: true, busy: true, waiting_for: null, raw: {} });
    s.ob.enqueue("u1", "k", { kind: "spawn", spec: spec("u1") }); await s.ob.run("u1");
    expect(s.runner.calls.filter((c) => c.kind === "spawn").length).toBe(0);
    expect(s.states()).toEqual(["unknown"]);                                       // surfaced for a person to resolve against `claude agents`
    const t = loadTask(s.db, "u1")!; expect(t.status).toBe("error"); expect(t.short_id).toBeNull();
  });
  test("a spawn relay could not read the outcome of stays `unknown` (never a second spawn) and parks the task in `error`", async () => {
    const s = setup(); s.mk("u1", "starting");
    s.runner.spawn = async () => { throw new Error("spawn failed (1): claude printed no backgrounded line"); };
    s.ob.enqueue("u1", "k", { kind: "spawn", spec: spec("u1") });
    await s.ob.run("u1");                                                         // the outbox owns the outcome: it must not throw at the scheduler
    expect(s.states()).toEqual(["unknown"]);                                      // B3: at-most-once — the operator confirms or retries, relay never retries a spawn on its own
    const t = loadTask(s.db, "u1")!;
    expect(t.status).toBe("error"); expect(t.process_state).toBe("none");         // visible, and no longer entitled to the slot it was granted
    expect(t.last_summary).toContain("spawn failed");
    await s.ob.run("u1"); expect(s.states()).toEqual(["unknown"]);                // the unknown head blocks the queue: still no second spawn
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
  test("a stop whose process.ended lands after a newer generation is alive leaves the live process alone; a stop of the current generation still ends it", async () => {
    const s = setup(); s.mk("u1", "running", { session_id: "sid", short_id: "fake1", process_state: "alive", process_generation: 1 }); s.live("u1");
    const stop = s.runner.stop.bind(s.runner);
    // The fork's SessionStart lands while `claude stop` is still being awaited: generation 2 is alive before the stop
    // gets to emit its process.ended for generation 1.
    s.runner.stop = async (short: string) => { await stop(short); s.log.emit({ type: "process.started", task_uuid: "u1", process_generation: 2, payload: { generation: 2, session_id: "sid2", short_id: "fake2" } }); };
    s.ob.enqueue("u1", "s", { kind: "stop", reason: "interrupt" }); await s.ob.run("u1");
    const t = loadTask(s.db, "u1")!;
    expect(t.process_state).toBe("alive"); expect(t.process_generation).toBe(2); expect(t.status).toBe("running");
    expect(s.db.query("select count(*) c from process_instances where task_uuid='u1' and ended_at is null").get()).toEqual({ c: 1 });   // I4
    s.runner.stop = stop;
    s.ob.enqueue("u1", "s2", { kind: "stop", reason: "interrupt" }); await s.ob.run("u1");
    expect(loadTask(s.db, "u1")!.process_state).toBe("stopped");
    expect(s.db.query("select count(*) c from process_instances where task_uuid='u1' and ended_at is null").get()).toEqual({ c: 0 });
  });
  test("a fork-resume reaps the session it superseded and never the one it just bound to", async () => {
    const s = setup("resume"); s.mk("u1", "starting", { process_generation: 0 });
    s.runner.rows.set("gen1", { short_id: "gen1", session_id: "sid-1", name: "relay:T-01 t", cwd: "/p", pid: 5, alive: true, busy: false, waiting_for: null, raw: {} });
    // exactly what ingest.ts emits for a SessionStart: a session id and no short id, which is why the reap set is keyed by session
    s.log.emit({ type: "process.started", task_uuid: "u1", process_generation: 1, payload: { generation: 1, session_id: "sid-1" } });
    expect(s.db.query("select short_id from process_instances where task_uuid='u1'").get()).toEqual({ short_id: null });
    s.ob.enqueue("u1", "r1", { kind: "resume", prompt: "continue", marker: "0000cafe" }); await s.ob.run("u1");
    expect(loadTask(s.db, "u1")!.short_id).toBe("fake1");                                             // `--bg --resume` forked to a new session
    // stop only. The fork is alive in the SAME worktree, and `claude rm` on a superseded session can take that
    // worktree with it, so deregistering waits for close.
    expect(s.runner.calls.filter((c) => c.kind === "stop" || c.kind === "rm").map((c) => `${c.kind} ${c.args}`)).toEqual(["stop gen1", "stop gen1"]);
    expect(s.runner.rows.get("gen1")!.alive).toBe(false); expect(s.runner.rows.get("fake1")!.alive).toBe(true);
    expect(s.states()).toEqual(["applied", "applied"]);
  });
  test("a reap refused because the shared worktree still holds work keeps the session and still applies", async () => {
    const s = setup(); s.mk("u1", "running", { process_generation: 0, worktree_path: "/p/wt" });
    for (const [g, short] of [[1, "gen1"], [2, "gen2"]] as [number, string][]) {
      s.runner.rows.set(short, { short_id: short, session_id: `sid-${short}`, name: "relay:T-01 t", cwd: "/p", pid: g, alive: true, busy: false, waiting_for: null, raw: {} });
      s.log.emit({ type: "process.started", task_uuid: "u1", process_generation: g, payload: { generation: g, session_id: `sid-${short}` } });
      s.log.emit({ type: "task.patched", task_uuid: "u1", payload: { patch: { short_id: short } } });                     // the outbox stamps the short id after the fork's SessionStart
    }
    s.runner.rm = async (short: string) => { s.runner.calls.push({ kind: "rm", args: short }); return { worktreeKept: true }; };   // the generations share one worktree and gen2's work is still in it
    s.log.emit({ type: "task.patched", task_uuid: "u1", payload: { patch: { process_state: "stopped" } } });   // close stops everything before anything is removed
    expect(s.ob.reapStops(loadTask(s.db, "u1")!, "test")).toEqual(["sid-gen1"]);
    s.ob.reapRms(loadTask(s.db, "u1")!); await s.ob.run("u1");
    expect(s.runner.calls.filter((c) => c.kind === "rm").map((c) => c.args)).toEqual(["gen1"]);
    expect(s.states()).toEqual(["applied", "failed"]);                                                 // a kept worktree means the session is still registered — never "applied" (Phase 0 capabilities.json:448)
    expect(s.runner.rows.has("gen1")).toBe(true);
    expect(s.db.query("select count(*) c from events where type='worktree.kept'").get()).toEqual({ c: 1 });
  });
  test("a reap never removes a session while a generation of the task is still alive in the shared worktree", async () => {
    const s = setup(); s.mk("u1", "running", { process_generation: 0, worktree_path: "/p/wt" });
    for (const [g, short] of [[1, "gen1"], [2, "gen2"]] as [number, string][]) {
      s.runner.rows.set(short, { short_id: short, session_id: `sid-${short}`, name: "relay:T-01 t", cwd: "/p", pid: g, alive: true, busy: false, waiting_for: null, raw: {} });
      s.log.emit({ type: "process.started", task_uuid: "u1", process_generation: g, payload: { generation: g, session_id: `sid-${short}` } });
      s.log.emit({ type: "task.patched", task_uuid: "u1", payload: { patch: { short_id: short } } });
    }
    expect(loadTask(s.db, "u1")!.process_state).toBe("alive");
    s.ob.reapRms(loadTask(s.db, "u1")!); await s.ob.run("u1");
    expect(s.runner.calls.filter((c) => c.kind === "rm").length).toBe(0);                              // gen2 is editing in that worktree — `claude rm` on gen1 could delete it underneath
    expect(s.runner.rows.has("gen1")).toBe(true);
    expect(s.states()).toEqual(["failed"]);                                                            // refused, visible, retryable — never silently "applied"
  });
  test("a task's own rm that ends unknown parks the task in error — `closed` is projected from that result, so it must not vanish", async () => {
    const s = setup(); s.mk("u1", "done", { session_id: "sid", short_id: "fake1", process_state: "stopped" });
    s.runner.rm = async () => { throw new Error("claude: command not found"); };
    s.ob.enqueue("u1", "rm1", { kind: "rm" }); await s.ob.run("u1");
    expect(s.states()).toEqual(["unknown"]);
    expect(loadTask(s.db, "u1")!.status).toBe("error");                                                // not left at `done` with a session still registered
    expect(loadTask(s.db, "u1")!.last_summary).toContain("may still be registered");
  });
  test("a relay restart mid-rm parks the task the same way — that path never reaches the catch", async () => {
    const s = setup(); s.mk("u1", "done", { session_id: "sid", short_id: "fake1", process_state: "stopped" });
    s.ob.enqueue("u1", "rm1", { kind: "rm" }); s.db.run("update commands set state='running'");
    s.ob.enqueue("u1", "reap", { kind: "rm", target: { session_id: "sid-old", short_id: null } }); s.db.run("update commands set state='running' where id like 'rm:%'");
    expect(s.ob.reconcileRunning().unknown.length).toBeGreaterThan(0);
    expect(loadTask(s.db, "u1")!.status).toBe("error");
  });
  test("a worktree locked because the session is still exiting holds the rm instead of recording a refusal", async () => {
    const s = setup(); s.mk("u1", "done", { session_id: "sid", short_id: "fake1", process_state: "stopped" });
    s.runner.keepWorktree = { reason: "worktree is locked — in use by another live session, or locked by hand", keptPath: "/p/wt", retryable: true };
    s.ob.enqueue("u1", "rm1", { kind: "rm" }); await s.ob.run("u1");
    expect(s.states()).toEqual(["pending"]);                                                           // still queued, not refused
    expect(loadTask(s.db, "u1")!.status).toBe("done");                                                 // nothing for a person to do, so nothing is said
    expect(s.db.query("select count(*) c from events where type='worktree.kept'").get()).toEqual({ c: 0 });
    s.runner.keepWorktree = null; await s.ob.run("u1");                                                // the session finished exiting; the reaper's kick re-runs it
    expect(s.states()).toEqual(["applied"]); expect(loadTask(s.db, "u1")!.status).toBe("closed");
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
