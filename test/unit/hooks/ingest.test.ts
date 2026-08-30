import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { openDb, migrate, setMeta } from "../../../src/db/db.ts";
import { EventLog, loadTask } from "../../../src/core/events.ts";
import { parseConfig } from "../../../src/config.ts";
import { readOwner } from "../../../src/lifecycle/outbox.ts";
import { ingestHook, permissionId, resolveTask, type IngestDeps } from "../../../src/hooks/ingest.ts";
import stopFx from "../../fixtures/stop-done.json";
import permFx from "../../fixtures/permission-request.json";
import subStartFx from "../../fixtures/subagent-start.json";
import subStopFx from "../../fixtures/subagent-stop.json";

const cfg = parseConfig("");
function setup() {
  const db = openDb(":memory:"); migrate(db); const log = new EventLog(db, () => {}, cfg);
  db.run("insert into projects(id,name,path,created_at) values('p1','p','/p',1)");
  log.emit({ type: "task.created", task_uuid: "u1", payload: { uuid: "u1", num: 1, display_id: "T-01", project_id: "p1", title: "t", status: "starting", size: "normal", effort: "xhigh", model: "m", session_id: null, short_id: "s1", worktree_path: "/p/.claude/worktrees/relay-x", branch: null, base_sha: null, process_state: "starting", process_generation: 0, turn_state: "idle", attach_state: "none", attached_by: null, paused: false, last_summary: null, last_step: null, question: null, parent_uuid: null, agent_id: null, agent_type: null, queued_at: null, qhead: false, started_at: 1, ended_at: null, created_at: 1, updated_at: 1, closed_at: null, usage_tokens: 0 } });
  const acquired: string[] = []; const stops: any[] = []; const crashes: string[] = []; const tools: string[] = []; const nudges: string[] = []; const questions: string[] = []; const limits: string[] = [];
  const deps: IngestDeps = { db, log,
    permits: { acquire: (h) => { if (acquired.length >= 1) return false; acquired.push(h.holder_id); return true; }, release: (id) => { const i = acquired.indexOf(id); if (i >= 0) acquired.splice(i, 1); }, rebind: (a, b) => { const i = acquired.indexOf(a); if (i >= 0) acquired[i] = b; }, firstUnbound: () => acquired.find((h) => h.startsWith("sub:")) ?? null },
    policy: { decide: () => "ask" }, onStop: (t, b) => stops.push([t.uuid, b]), onCrash: (t, r) => crashes.push(r), onToolUse: (t, p) => tools.push(String(p)), onNudge: (t) => nudges.push(t.uuid), onQuestion: (t, q) => questions.push(q.text), onRateLimit: (t, x) => limits.push(x), onSendMarker: () => {}, permissions: new Map() };
  const post = (body: Record<string, unknown>, task = "u1", opts?: { replay?: boolean }) => ingestHook({ session_id: "sess-1", transcript_path: "/t", cwd: "/p/.claude/worktrees/relay-x", ...body }, { "x-relay-task": task }, deps, opts);
  return { db, log, deps, post, acquired, stops, crashes, tools, nudges, questions, limits };
}
describe("ingestHook", () => {
  test("SessionStart binds session_id, bumps generation, marks alive; a foreign session cannot rebind the task", () => {
    const s = setup(); expect(s.post({ hook_event_name: "SessionStart", source: "startup" }).status).toBe(200);
    const t = loadTask(s.db, "u1")!; expect(t.session_id).toBe("sess-1"); expect(t.process_generation).toBe(1); expect(t.process_state).toBe("alive"); expect(t.status).toBe("running");
    s.post({ hook_event_name: "SessionStart", source: "resume" }); expect(loadTask(s.db, "u1")!.process_generation).toBe(2);
    const foreign = s.post({ hook_event_name: "SessionStart", source: "startup", session_id: "evil" }); expect(foreign.status).toBe(202); expect(loadTask(s.db, "u1")!.session_id).toBe("sess-1");
  });
  test("duplicate tool hook is stored once; PostToolUse feeds the tool-call counter", () => {
    const s = setup(); s.post({ hook_event_name: "SessionStart", source: "startup" });
    s.post({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "tu1", tool_input: {}, tool_response: "", prompt_id: "p1" }); s.post({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "tu1", tool_input: {}, tool_response: "", prompt_id: "p1" });
    expect(s.db.query("select count(*) c from events where type='hook.PostToolUse'").get()).toEqual({ c: 1 });
    expect(loadTask(s.db, "u1")!.last_step).toBe("Bash"); expect(s.tools).toEqual(["p1"]);
  });
  test("PreToolUse(Agent) grants a lease or denies; SubagentStart rebinds the lease, SubagentStop releases it", () => {
    const s = setup(); s.post({ hook_event_name: "SessionStart", source: "startup" });
    const a = s.post({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "tuA", tool_input: { subagent_type: "relay-explore" } });
    expect((a as any).json).toEqual({}); expect(s.acquired).toEqual(["sub:u1:tuA"]);
    const b = s.post({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "tuB", tool_input: {} });
    expect(((b as any).json as any).hookSpecificOutput.permissionDecision).toBe("deny");
    s.post({ hook_event_name: "SubagentStart", agent_id: "ag1", agent_type: "relay-explore" });
    expect(s.db.query("select count(*) c, min(display_id) d from tasks where parent_uuid='u1'").get()).toEqual({ c: 1, d: "T-01.1" });
    expect(s.db.query("select max(num) n from tasks where parent_uuid is null").get()).toEqual({ n: 1 });   // sub-tasks never consume top-level numbers
    expect(s.acquired).toEqual(["agent:ag1"]);
    s.post({ hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "relay-explore", last_assistant_message: "found it" });
    expect(s.acquired).toEqual([]); expect(s.db.query("select status from tasks where agent_id='ag1'").get()).toEqual({ status: "done" });
  });
  test("the measured SubagentStart/SubagentStop payloads drive the same path", () => {
    const s = setup(); s.post({ hook_event_name: "SessionStart", source: "startup" });
    s.post({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "tuA", tool_input: {} });
    s.post({ ...(subStartFx as any), session_id: "sess-1" });
    const child = s.db.query("select uuid, agent_id, title from tasks where parent_uuid='u1'").get() as any;
    expect(child.agent_id).toBe((subStartFx as any).agent_id); expect(child.title).toBe("relay-explore"); expect(s.acquired).toEqual([`agent:${(subStartFx as any).agent_id}`]);
    s.post({ ...(subStopFx as any), session_id: "sess-1" });
    expect(s.acquired).toEqual([]); expect((s.db.query("select status, last_summary from tasks where uuid=?").get(child.uuid) as any).status).toBe("done");
  });
  test("PermissionRequest: policy ask → waiting_input + question(source=permission); the HTTP response is held until answered; replay never holds", async () => {
    const s = setup(); s.post({ hook_event_name: "SessionStart", source: "startup" });
    const r = s.post({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_use_id: "tuP", tool_input: { command: "rm -rf build" } });
    expect("wait" in r).toBe(true); const t = loadTask(s.db, "u1")!; expect(t.status).toBe("waiting_input"); expect(t.question!.source).toBe("permission");
    s.deps.permissions.get("sess-1:tuP")!.resolve("allow");
    expect(await (r as any).wait).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    const d = s.post({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_use_id: "tuQ", tool_input: { command: "x" } }); s.deps.permissions.get("sess-1:tuQ")!.resolve("deny");
    expect((await (d as any).wait).hookSpecificOutput.decision.behavior).toBe("deny");
    const rp = s.post({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_use_id: "tuR", tool_input: { command: "y" } }, "u1", { replay: true }); expect("wait" in rp).toBe(false);
  });
  test("the measured PermissionRequest payload carries no tool_use_id — the request is still keyed, held and answerable", async () => {
    const s = setup(); s.post({ hook_event_name: "SessionStart", source: "startup" });
    expect((permFx as any).tool_use_id).toBeUndefined();
    const r = s.post({ ...(permFx as any), session_id: "sess-1" });
    expect("wait" in r).toBe(true);
    const key = permissionId(permFx as any); expect(key).toStartWith("pr:");
    const t = loadTask(s.db, "u1")!; expect(t.question!.permission_tool_use_id).toBe(key);
    const dup = s.post({ ...(permFx as any), session_id: "sess-1" }); expect((dup as any).wait).toBe((r as any).wait); expect(s.questions.length).toBe(1);
    s.deps.permissions.get(`sess-1:${key}`)!.resolve("allow");
    expect((await (r as any).wait).hookSpecificOutput.decision.behavior).toBe("allow");
  });
  test("Stop reaches verdict; a Stop from an older generation (same session id after --resume) is stored but ignored", () => {
    const s = setup(); s.post({ hook_event_name: "SessionStart", source: "startup" });
    s.post({ hook_event_name: "UserPromptSubmit", prompt: "go", prompt_id: "turn-1" });                 // gen 1 owns turn-1
    s.post({ hook_event_name: "SessionEnd", reason: "other" }); s.post({ hook_event_name: "SessionStart", source: "resume" });   // gen 2
    s.post({ ...(stopFx as any), session_id: "sess-1", prompt_id: "turn-1" });                           // late Stop of the old process
    expect(s.stops.length).toBe(0); expect(s.db.query("select count(*) c from events where type='hook.Stop'").get()).toEqual({ c: 1 });
    s.post({ hook_event_name: "UserPromptSubmit", prompt: "again", prompt_id: "turn-2" }); s.post({ ...(stopFx as any), session_id: "sess-1", prompt_id: "turn-2" });
    expect(s.stops.length).toBe(1);
  });
  test("unknown session without header → 202 orphan, no crash", () => {
    const s = setup(); const r = ingestHook({ session_id: "ghost", hook_event_name: "Stop", transcript_path: "/t", cwd: "/x" }, {}, s.deps);
    expect(r.status).toBe(202); expect(s.db.query("select count(*) c from events where task_uuid is null").get()).toEqual({ c: 1 });
  });
  test("SessionEnd while running (no stop command of ours) is a crash; PostToolUse(SendMessage) records message.sent; Notification nudges", () => {
    const s = setup(); s.post({ hook_event_name: "SessionStart", source: "startup" });
    s.post({ hook_event_name: "PostToolUse", tool_name: "SendMessage", tool_use_id: "tuS", tool_input: { to: "relay:T-02 x", message: "hi" }, tool_response: { success: true } });
    expect(s.db.query("select count(*) c from events where type='message.sent'").get()).toEqual({ c: 1 });
    s.post({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "…" }); expect(s.nudges).toEqual(["u1"]);
    s.post({ hook_event_name: "SessionEnd", reason: "other" }); expect(loadTask(s.db, "u1")!.process_state).toBe("crashed"); expect(s.crashes).toEqual(["SessionEnd(other) while running"]);
  });
  test("SessionEnd after a task is done is a plain stop, not a crash", () => {
    const s = setup(); s.post({ hook_event_name: "SessionStart", source: "startup" });
    s.log.emit({ type: "task.status_changed", task_uuid: "u1", payload: { status: "done", patch: { status: "done" } } });
    s.post({ hook_event_name: "SessionEnd", reason: "other" }); expect(loadTask(s.db, "u1")!.process_state).toBe("stopped"); expect(s.crashes).toEqual([]);
  });
  test("generation nonce (X-Relay-Gen): SessionStart is idempotent per generation; hooks from an older generation are stored but ignored; an old SessionStart cannot roll the generation back", () => {
    const s = setup(); const post = (b: Record<string, unknown>, gen: number) => ingestHook({ session_id: "sess-1", transcript_path: "/t", cwd: "/p/.claude/worktrees/relay-x", ...b }, { "x-relay-task": "u1", "x-relay-gen": String(gen) }, s.deps);
    post({ hook_event_name: "SessionStart", source: "startup" }, 1); post({ hook_event_name: "SessionStart", source: "startup" }, 1);   // retried delivery of the same hook
    expect(loadTask(s.db, "u1")!.process_generation).toBe(1);
    post({ hook_event_name: "SessionStart", source: "resume" }, 2); expect(loadTask(s.db, "u1")!.process_generation).toBe(2);
    post({ ...(stopFx as any), session_id: "sess-1", prompt_id: "old-turn" }, 1);                       // the old process's Stop arrives late
    expect(s.stops.length).toBe(0); expect(s.db.query("select count(*) c from events where type='hook.Stop'").get()).toEqual({ c: 1 });
    post({ hook_event_name: "SessionStart", source: "startup" }, 1); expect(loadTask(s.db, "u1")!.process_generation).toBe(2);
    post({ ...(stopFx as any), session_id: "sess-1", prompt_id: "new-turn" }, 2); expect(s.stops.length).toBe(1);
  });
  test("a duplicate PermissionRequest shares the pending wait; SessionEnd auto-denies whatever is still held", async () => {
    const s = setup(); s.post({ hook_event_name: "SessionStart", source: "startup" });
    const a = s.post({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_use_id: "tuP", tool_input: { command: "x" } });
    const b = s.post({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_use_id: "tuP", tool_input: { command: "x" } });
    expect((b as any).wait).toBe((a as any).wait); expect(s.questions.length).toBe(1);
    s.post({ hook_event_name: "SessionEnd", reason: "other" });
    expect((await (a as any).wait).hookSpecificOutput.decision.behavior).toBe("deny"); expect(s.deps.permissions.size).toBe(0);
  });
  test("an Agent call that returns without SubagentStart drops its provisional lease", () => {
    const s = setup(); s.post({ hook_event_name: "SessionStart", source: "startup" });
    s.post({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "tuA", tool_input: {} }); expect(s.acquired).toEqual(["sub:u1:tuA"]);
    s.post({ hook_event_name: "PostToolUseFailure", tool_name: "Agent", tool_use_id: "tuA", tool_input: {}, error: "denied" }); expect(s.acquired).toEqual([]);
  });
  // The kill switch onRateLimit trips is GLOBAL, so what may trip it is narrow: only where the model or the API itself
  // reports a limit (a failed tool call's error, the assistant's own last message), never the stdout of a command the
  // worker ran. `bun install` printing `+ express-rate-limit@8.5.2` once stopped every task in the fleet.
  test("tool output never trips the kill switch, whatever words it happens to contain", () => {
    const s = setup(); s.post({ hook_event_name: "SessionStart", source: "startup" });
    const out = (id: string, tool_response: unknown) => s.post({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: id, tool_input: {}, tool_response });
    out("tu1", "bun install v1.4.0\n+ express-rate-limit@8.5.2\n+ hono@4.13.5\n103 packages installed");   // the incident
    out("tu2", "+ http-errors@429.0.0 downloaded from https://registry.example.com/429/too-many-requests.tgz");
    out("tu3", "src/api/client.ts:42:  if (res.status === 429) throw new Error('rate limit exceeded, retry later');");   // a grep hit
    out("tu4", { stdout: "Disk quota exceeded: /dev/sda1 is at 100% of its quota", exit_code: 1 });
    out("tu5", "Claude usage limit reached — the phrase quoted inside a log file the worker just read");
    expect(s.limits).toEqual([]);
  });
  test("a limit the model or the API reports does trip the kill switch, with its reset time intact", () => {
    const s = setup(); s.post({ hook_event_name: "SessionStart", source: "startup" });
    s.post({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "tuF", tool_input: {}, error: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}' });
    expect(s.limits.length).toBe(1);
    s.post({ ...(stopFx as any), session_id: "sess-1", prompt_id: "turn-limit", last_assistant_message: "Claude usage limit reached. Your limit will reset at 3:00pm." });
    expect(s.limits.length).toBe(2); expect(s.limits[1]).toContain("3:00pm");
    s.post({ ...(stopFx as any), session_id: "sess-1", prompt_id: "turn-ok", last_assistant_message: "Done — I added express-rate-limit@8.5.2 and a 429 handler, and the quota docs are in README." });
    expect(s.limits.length).toBe(2);                                                                   // merely talking about limits is not hitting one
  });
  test("a --bg --resume fork rebinds the session chain: the new id takes over, the old one stays resolvable, and its late hooks are stale rather than foreign", () => {
    const s = setup(); s.post({ hook_event_name: "SessionStart", source: "startup" });
    expect(loadTask(s.db, "u1")!.session_id).toBe("sess-1");
    // relay issued the resume that produced the fork
    s.log.emit({ type: "command.queued", task_uuid: "u1", payload: { id: "resume:u1", kind: "resume", payload: { kind: "resume", prompt: "go on", marker: "0000ffff" } } });
    s.log.emit({ type: "command.applied", task_uuid: "u1", payload: { id: "resume:u1" } });
    const forked = ingestHook({ session_id: "sess-2", transcript_path: "/t", cwd: "/p/.claude/worktrees/relay-x", hook_event_name: "SessionStart", source: "fork" }, { "x-relay-task": "u1" }, s.deps);
    expect(forked.status).toBe(200);
    const t = loadTask(s.db, "u1")!; expect(t.session_id).toBe("sess-2"); expect(t.process_generation).toBe(2); expect(t.turn_state).toBe("busy");   // "fork" counts as a resume
    expect(resolveTask(s.db, { session_id: "sess-1" })!.uuid).toBe("u1");                              // superseded id still resolves via process_instances
    s.post({ ...(stopFx as any), session_id: "sess-1", prompt_id: "old-turn" }); expect(s.stops.length).toBe(0);   // I7: older generation, recorded only
    ingestHook({ ...(stopFx as any), session_id: "sess-2", transcript_path: "/t", cwd: "/p", prompt_id: "new-turn" }, { "x-relay-task": "u1" }, s.deps);
    expect(s.stops.length).toBe(1);                                                                    // the live session still drives the verdict
  });
  test("a fork source does not bypass the binding guard when relay has no spawn/resume in flight", () => {
    const s = setup(); s.post({ hook_event_name: "SessionStart", source: "startup" });
    const r = ingestHook({ session_id: "sess-9", transcript_path: "/t", cwd: "/x", hook_event_name: "SessionStart", source: "fork" }, { "x-relay-task": "u1" }, s.deps);
    expect(r.status).toBe(202); expect(loadTask(s.db, "u1")!.session_id).toBe("sess-1");
  });
  test("the first hook records the worktree path (the only place the CLI exposes it) and lands the deferred ownership stamp", () => {
    const s = setup(); const wt = mkdtempSync(join(tmpdir(), "relay-wt-hook-"));
    s.db.run("update tasks set worktree_path=null where uuid='u1'"); setMeta(s.db, "relay_instance_id", "inst");
    ingestHook({ session_id: "sess-1", transcript_path: "/t", cwd: wt, hook_event_name: "SessionStart", source: "startup" }, { "x-relay-task": "u1" }, s.deps);
    expect(loadTask(s.db, "u1")!.worktree_path).toBe(wt);
    expect(readOwner(wt)).toMatchObject({ task_uuid: "u1", relay_instance_id: "inst", session_id: "sess-1" });
  });
  test("an unknown hook name is rejected; WorktreeCreate is accepted even though relay never injects it", () => {
    const s = setup(); s.post({ hook_event_name: "SessionStart", source: "startup" });
    expect(s.post({ hook_event_name: "Nonsense" }).status).toBe(400);
    expect(s.post({ hook_event_name: "WorktreeCreate", worktree_path: "/p/wt", base_path: "/p" }).status).toBe(200);
  });
});
