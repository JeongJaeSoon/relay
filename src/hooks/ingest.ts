// src/hooks/ingest.ts — turn native hook payloads into events (contract: roadmap B4).
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Task, TaskQuestion } from "@shared/types.ts";
import { now } from "../core/clock.ts";
import { EventLog, loadTask } from "../core/events.ts";
import { taskUuid as newUuid, ulid } from "../core/ids.ts";
import { log as slog } from "../log.ts";
import { getMeta } from "../db/db.ts";
import { writeOwner } from "../lifecycle/outbox.ts";
import { pushInbox } from "./inbox.ts";

/** Every hook event relay understands on `POST /api/hooks`. */
export const ALL_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied", "SubagentStart", "SubagentStop", "Notification", "Stop", "SessionEnd", "WorktreeCreate", "WorktreeRemove"];
/** What `--settings` actually registers on a worker session. `WorktreeCreate` is a *provider* hook, not an observation
 *  hook: Phase 0 measured that registering it makes the CLI abort session init ("hook succeeded but returned no
 *  worktree path"), so relay must never inject it — it stays in ALL_HOOK_EVENTS only so a payload from elsewhere is
 *  still accepted rather than 400'd. */
export const INJECTED_HOOK_EVENTS = ALL_HOOK_EVENTS.filter((e) => e !== "WorktreeCreate");

export type PermissionKey = string;                                          // `${session_id}:${permissionId(body)}`
export interface PendingPermission { resolve: (d: "allow" | "deny") => void; wait: Promise<unknown>; task_uuid: string; session_id: string }
export interface IngestDeps {
  db: Database; log: EventLog;
  permits: { acquire(h: { holder_kind: "subagent"; holder_id: string; task_uuid: string }): boolean; release(holderId: string): void; rebind(from: string, to: string): void; firstUnbound(taskUuid: string): string | null };
  policy: { decide(body: any, task: Task): "allow" | "deny" | "ask" };
  onStop: (task: Task, body: any) => void;
  onCrash: (task: Task, reason: string) => void;                            // process ended while the task was running (no stop command of ours)
  onQuestion: (task: Task, q: TaskQuestion) => void;                        // chat promotion for permission questions (marker questions come via onStop)
  onToolUse: (task: Task, promptId: string | null) => void;                  // per-turn tool-call cap (usage guard)
  onNudge: (task: Task) => void;                                             // Notification that suggests the CLI is waiting → watchdog tick
  onRateLimit: (task: Task, text: string) => void;                           // the model or the API reported a subscription/rate limit → kill switch (§11)
  onSendMarker: (taskUuid: string, markerId: string) => void;
  permissions: Map<PermissionKey, PendingPermission>;                        // held PermissionRequest responses, answered via TaskService.answer()
}
export type IngestResult = { status: number; json: unknown } | { status: 200; wait: Promise<unknown> };

/** Identifies one permission request. The measured payload (Phase 0 `permission-request.json`) carries **no
 *  `tool_use_id`** — the request is raised before the tool call exists — so fall back to a digest of the turn plus the
 *  tool and its input. Two deliveries of the same request hash the same, which is exactly the dedupe B4 wants.
 *  ponytail: the ceiling is two IDENTICAL pending tool calls in one turn — they share a digest and so share one
 *  allow/deny. Fixing that means correlating back to the preceding PreToolUse (which does carry `tool_use_id`) and
 *  carrying that state per turn; not worth it until someone sees it happen. */
export const permissionId = (b: any): string => b.tool_use_id ?? `pr:${createHash("sha256").update(`${b.prompt_id ?? ""}|${b.tool_name ?? ""}|${JSON.stringify(b.tool_input ?? {})}`).digest("hex").slice(0, 16)}`;

export function sourceEventId(b: any, gen: number | null): string {
  switch (b.hook_event_name) {
    case "SessionStart": return `ss:${gen ?? "?"}:${b.source ?? "startup"}`;   // idempotent per generation (a retried SessionStart must not bump again)
    case "UserPromptSubmit": return b.prompt_id ?? `ups:${ulid()}`;
    case "PreToolUse": return `${b.tool_use_id}:pre`; case "PostToolUse": return `${b.tool_use_id}:post`; case "PostToolUseFailure": return `${b.tool_use_id}:fail`;
    case "PermissionRequest": return `${permissionId(b)}:perm`; case "PermissionDenied": return `${permissionId(b)}:denied`;
    case "SubagentStart": return `${b.agent_id}:start`; case "SubagentStop": return `${b.agent_id}:stop`;
    case "Stop": return `stop:${b.prompt_id ?? ulid()}`; case "SessionEnd": return `end:${gen ?? "?"}`;
    default: return `${b.hook_event_name}:${ulid()}`;
  }
}
export function resolveTask(db: Database, b: any, headerTask?: string): Task | null {
  if (headerTask) { const t = loadTask(db, headerTask); if (t) return t; }
  if (b.relay_task_uuid) { const t = loadTask(db, b.relay_task_uuid); if (t) return t; }
  const r = db.query("select uuid from tasks where session_id=?").get(b.session_id) as any; if (r) return loadTask(db, r.uuid);
  // a superseded link in the session chain: `--bg --resume` forks to a new id, and every id relay has seen for this
  // task survives on its process_instances rows, so a late hook from the old process still lands on the right task
  const pi = db.query("select task_uuid from process_instances where session_id=? order by generation desc limit 1").get(b.session_id) as any; if (pi) return loadTask(db, pi.task_uuid);
  const w = db.query("select uuid from tasks where worktree_path=? and parent_uuid is null and status!='closed'").get(b.cwd) as any; return w ? loadTask(db, w.uuid) : null;
}
/** `--bg --resume` forks to a NEW session id (source "fork"); a supervisor respawn keeps the old one (source "resume"). */
const RESUMED_SOURCES = new Set(["resume", "fork"]);
const START_WINDOW_MS = 120_000;
/** A spawn/resume relay itself issued just now — the only situation in which a task may bind to a different session id. */
const startInFlight = (db: Database, taskUuid: string): boolean =>
  !!db.query("select 1 from commands where task_uuid=? and kind in ('spawn','resume') and (state='running' or (state='applied' and applied_at>=?))").get(taskUuid, now() - START_WINDOW_MS);
const stepOf = (b: any) => { const i = b.tool_input ?? {}; const d = i.file_path ?? i.path ?? i.pattern ?? (typeof i.command === "string" ? i.command.slice(0, 40) : i.description); return d ? `${b.tool_name} ${String(d).split("/").slice(-2).join("/")}`.slice(0, 60) : String(b.tool_name); };
const PERMISSION_AUTO_DENY_MS = 14 * 60_000;   // must stay below the hook timeout (900s) so the CLI never sees a dangling request
/** A subscription/API limit **as the model or the API words it**. Deliberately narrow, and read only on the paths where
 *  one of them speaks (a failed tool call's error, the assistant's own last message) — never over a tool's output, which
 *  is arbitrary text the worker's command happened to print. The switch this feeds is GLOBAL: missing a real limit costs
 *  one retry the user can trigger, a false positive stops every task, so a bare `429`, a bare `quota` or a bare mention
 *  of "rate limit" are not enough (`bun install` printing `+ express-rate-limit@8.5.2` once stopped the whole fleet). */
const RATE_LIMIT = new RegExp([
  String.raw`\b(?:usage|rate|request)[ _-]?limits?\b[^.\n]{0,30}?\b(?:reached|exceeded|hit)\b`,          // "usage limit reached", "rate limit exceeded"
  String.raw`\b(?:reach(?:ed|es)?|exceed(?:ed|s)?|hit)\b[^.\n]{0,40}?\byour\b[^.\n]{0,25}?\blimits?\b`,  // "you've hit your limit", "has exceeded your rate limit"
  String.raw`\brate_limit_error\b`,                                                                       // the Anthropic API error type
  String.raw`\btoo many requests\b`,                                                                      // the 429 status text
].join("|"), "i");
/** Deny every held PermissionRequest of a session (SessionEnd, crash, relay shutdown). */
export function cancelPermissions(perms: Map<PermissionKey, PendingPermission>, sessionId: string) { for (const [k, p] of perms) if (p.session_id === sessionId) { p.resolve("deny"); perms.delete(k); } }

export function ingestHook(body: any, headers: Record<string, string | undefined>, d: IngestDeps, opts: { replay?: boolean } = {}): IngestResult {
  if (getMeta(d.db, "recovering") === "1" && !opts.replay) { pushInbox(d.db, body, headers); return { status: 200, json: {} }; }   // durable: survives a crash mid-recovery
  const ev = String(body.hook_event_name ?? ""); if (!ALL_HOOK_EVENTS.includes(ev)) return { status: 400, json: { error: "unknown hook" } };
  const task = resolveTask(d.db, body, headers["x-relay-task"]);
  const headerGen = headers["x-relay-gen"] != null && headers["x-relay-gen"] !== "" ? Number(headers["x-relay-gen"]) : body.relay_gen != null && body.relay_gen !== "" ? Number(body.relay_gen) : null;   // generation nonce relay put in the worker env
  const orphan = () => { slog.warn("orphan hook", { ev, session: body.session_id }); d.log.emit({ type: `hook.${ev}`, task_uuid: null, process_generation: headerGen, source_session_id: body.session_id ?? null, source_event_id: sourceEventId(body, headerGen), payload: body }); return { status: 202, json: {} } as IngestResult; };
  if (!task) return orphan();
  const base = (gen: number | null) => ({ source_session_id: body.session_id ?? null, source_event_id: sourceEventId(body, gen), tool_use_id: body.tool_use_id ?? null, turn_id: body.prompt_id ?? null, payload: body });
  if (ev === "SessionStart") {
    // Binding guard. A task's session identity is a CHAIN, not a value: `claude --bg --resume` forks to a new session
    // id, so a differing id is legitimate exactly when this task's own token addressed us, relay has a spawn/resume in
    // flight, and no other task already owns that id (tasks.session_id is UNIQUE — orphan beats a rolled-back emit).
    const rebind = task.session_id != null && task.session_id !== body.session_id;
    if (rebind && !(headers["x-relay-task"] === task.uuid && startInFlight(d.db, task.uuid) && !d.db.query("select 1 from tasks where session_id=? and uuid<>?").get(body.session_id, task.uuid))) return orphan();
    const resumed = RESUMED_SOURCES.has(String(body.source ?? ""));
    const gen = headerGen ?? (task.process_state === "alive" && task.session_id === body.session_id && !resumed ? task.process_generation : task.process_generation + 1);
    if (headerGen != null && headerGen < task.process_generation) return { status: 200, json: {} };   // late SessionStart of an older process
    // The worktree path is exposed to relay only here (`agents --json` reports the launch cwd), so this is also where a
    // spawn-time stamp that had to be deferred finally lands (roadmap B8).
    const worktree = task.worktree_path ?? (typeof body.cwd === "string" && body.cwd ? body.cwd : null);
    if (!task.worktree_path && worktree) writeOwner(worktree, { relay_instance_id: getMeta(d.db, "relay_instance_id") ?? "", task_uuid: task.uuid, session_id: body.session_id ?? null });
    const stored = d.log.emit({ type: "process.started", task_uuid: task.uuid, process_generation: gen, ...base(gen), payload: { generation: gen, session_id: body.session_id, source: body.source, patch: { ...(!task.worktree_path && worktree ? { worktree_path: worktree } : {}), ...(resumed ? { turn_state: "busy" } : {}), ...(task.status === "starting" ? { status: "running", started_at: task.started_at ?? now() } : {}) } } });
    if (stored && task.status === "starting") d.log.emit({ type: "task.status_changed", task_uuid: task.uuid, payload: { status: "running", patch: {} } });
    return { status: 200, json: {} };
  }
  const gen = task.process_generation;
  // I7: a hook from an older process is recorded but must not touch projections. Staleness is decided by GENERATION,
  // never by comparing session ids — after a fork the live session's id differs from every earlier one, so an id test
  // would freeze the task forever. Signals, in order: the generation nonce (X-Relay-Gen); the generation this session
  // id was last seen with (process_instances); the turn's first-seen generation (a supervisor respawn keeps the id).
  const otherSession = body.session_id != null && task.session_id != null && body.session_id !== task.session_id;
  const sessionGen = otherSession ? (d.db.query("select generation g from process_instances where task_uuid=? and session_id=? order by generation desc limit 1").get(task.uuid, body.session_id) as any)?.g ?? null : null;
  const unplaceable = otherSession && sessionGen == null && headerGen == null;   // a session relay has never seen and cannot date
  const firstGen = headerGen == null && body.prompt_id ? (d.db.query("select process_generation g from events where source_session_id=? and turn_id=? and process_generation is not null order by seq limit 1").get(body.session_id, body.prompt_id) as any)?.g ?? null : null;
  const stale = unplaceable || (sessionGen != null && sessionGen < gen) || (headerGen != null && headerGen < gen) || (firstGen != null && firstGen < gen) || (ev !== "SessionEnd" && ["stopped", "crashed"].includes(task.process_state));
  const stored = d.log.emit({ type: `hook.${ev}`, task_uuid: task.uuid, process_generation: headerGen ?? gen, ...base(headerGen ?? gen) });
  if (stale) return { status: 200, json: {} };
  if (!stored) {                                                             // duplicate delivery: replay the same answer for a still-pending PermissionRequest, otherwise no-op
    if (ev === "PermissionRequest") { const p = d.permissions.get(`${body.session_id}:${permissionId(body)}`); if (p) return { status: 200, wait: p.wait }; }
    return { status: 200, json: {} };
  }
  const patch = (p: Record<string, unknown>) => d.log.emit({ type: "task.patched", task_uuid: task.uuid, payload: { patch: p } });
  const releaseProvisional = () => { const holder = `sub:${task.uuid}:${body.tool_use_id}`; d.permits.release(holder); };
  switch (ev) {
    case "UserPromptSubmit": {
      patch({ turn_state: "busy" });
      const m = String(body.prompt ?? "").match(/\[relay #([0-9a-f]{8})\]/); if (m) d.onSendMarker(task.uuid, m[1]);
      if (/<cross-session-message/.test(String(body.prompt ?? ""))) d.log.emit({ type: "message.sent", task_uuid: task.uuid, payload: { direction: "in", from: String(body.prompt).match(/from-name="([^"]+)"/)?.[1] ?? "?", text: String(body.prompt).slice(0, 500), outcome: "accepted" } });
      return { status: 200, json: {} };
    }
    case "PreToolUse": {
      patch({ last_step: stepOf(body) });
      if (body.tool_name === "Agent") {
        const holder = `sub:${task.uuid}:${body.tool_use_id}`;
        if (!d.permits.acquire({ holder_kind: "subagent", holder_id: holder, task_uuid: task.uuid })) return { status: 200, json: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "relay: no concurrency slot free — do this work yourself, sequentially" } } };
      }
      return { status: 200, json: {} };
    }
    case "PostToolUse": {
      patch({ last_step: stepOf(body) }); d.onToolUse(task, body.prompt_id ?? null);
      if (body.tool_name === "Agent") releaseProvisional();                  // the Agent call returned without a SubagentStart (denied/failed/foreground finished): drop the provisional lease
      if (body.tool_name === "SendMessage" || body.tool_name === "ListAgents") d.log.emit({ type: "message.sent", task_uuid: task.uuid, payload: { direction: "out", tool: body.tool_name, to: body.tool_input?.to ?? null, text: String(body.tool_input?.message ?? "").slice(0, 500), outcome: body.tool_response?.success === false ? "refused" : "accepted" } });
      return { status: 200, json: {} };
    }
    case "PostToolUseFailure": { patch({ last_step: `failed: ${body.tool_name}` }); d.onToolUse(task, body.prompt_id ?? null); if (body.tool_name === "Agent") releaseProvisional(); if (RATE_LIMIT.test(String(body.error ?? ""))) d.onRateLimit(task, String(body.error).slice(0, 200)); return { status: 200, json: {} }; }
    case "PermissionRequest": {
      if (opts.replay) return { status: 200, json: {} };                      // the CLI moved on to its own prompt long ago; never hold a replayed request
      const decision = d.policy.decide(body, task);
      if (decision !== "ask") return { status: 200, json: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: decision } } } };
      const permId = permissionId(body);
      const key: PermissionKey = `${body.session_id}:${permId}`;
      const q: TaskQuestion = { text: `Permission needed: ${body.tool_name} ${JSON.stringify(body.tool_input ?? {}).slice(0, 200)}`, options: ["Allow", "Deny"], asked_at: now(), source: "permission", permission_tool_use_id: permId };
      d.log.emit({ type: "question.asked", task_uuid: task.uuid, payload: { patch: { question: q } } });
      // The task lease is kept: the worker continues the instant relay answers (roadmap B4/I6 exception).
      d.log.emit({ type: "task.status_changed", task_uuid: task.uuid, payload: { status: "waiting_input", patch: { status: "waiting_input" } } });
      let resolveFn!: (d: "allow" | "deny") => void;
      const wait = new Promise<unknown>((resolve) => {
        const finish = (behavior: "allow" | "deny") => { clearTimeout(timer); d.permissions.delete(key); resolve({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior } } }); };
        const timer = setTimeout(() => finish("deny"), PERMISSION_AUTO_DENY_MS); resolveFn = finish;
      });
      d.permissions.set(key, { resolve: resolveFn, wait, task_uuid: task.uuid, session_id: body.session_id });
      d.onQuestion(loadTask(d.db, task.uuid)!, q);
      return { status: 200, wait };
    }
    case "SubagentStart": {
      const uuid = newUuid(); const n = (d.db.query("select count(*)+1 n from tasks where parent_uuid=?").get(task.uuid) as any).n;
      d.log.emit({ type: "task.created", task_uuid: uuid, payload: { uuid, num: -Number(`${task.num}${String(n).padStart(3, "0")}`), display_id: `${task.display_id}.${n}`, project_id: task.project_id, title: String(body.agent_type ?? "subagent"), status: "running", size: "small", effort: task.effort, model: task.model, session_id: null, short_id: null, worktree_path: task.worktree_path, branch: null, base_sha: null, process_state: "alive", process_generation: gen, turn_state: "busy", attach_state: "none", attached_by: null, paused: false, last_summary: null, last_step: null, question: null, parent_uuid: task.uuid, agent_id: body.agent_id, agent_type: body.agent_type ?? null, queued_at: null, qhead: false, started_at: now(), ended_at: null, created_at: now(), updated_at: now(), closed_at: null, usage_tokens: 0, summary_json: null } });
      // bind the lease acquired at PreToolUse(Agent) to this agent_id (oldest unbound lease of this task = the spawn that started first)
      const unbound = d.permits.firstUnbound(task.uuid);
      if (unbound) d.permits.rebind(unbound, `agent:${body.agent_id}`);
      else d.permits.acquire({ holder_kind: "subagent", holder_id: `agent:${body.agent_id}`, task_uuid: task.uuid });   // spawned while relay was down
      return { status: 200, json: {} };
    }
    case "SubagentStop": {
      const child = d.db.query("select uuid from tasks where agent_id=? and parent_uuid=?").get(body.agent_id, task.uuid) as any;
      if (child) d.log.emit({ type: "task.status_changed", task_uuid: child.uuid, payload: { status: "done", patch: { status: "done", ended_at: now(), turn_state: "idle", process_state: "stopped", last_summary: String(body.last_assistant_message ?? "").split("\n")[0].slice(0, 200) } } });
      d.permits.release(`agent:${body.agent_id}`); return { status: 200, json: {} };
    }
    case "Notification": { if (/permission|input|idle/.test(String(body.notification_type ?? ""))) d.onNudge(task); return { status: 200, json: {} }; }
    case "Stop": { patch({ turn_state: "idle" }); if (RATE_LIMIT.test(String(body.last_assistant_message ?? "").slice(0, 400))) d.onRateLimit(task, String(body.last_assistant_message).slice(0, 200)); d.onStop(loadTask(d.db, task.uuid)!, body); return { status: 200, json: {} }; }
    case "SessionEnd": {
      cancelPermissions(d.permissions, body.session_id);
      for (const c of d.db.query("select uuid, agent_id from tasks where parent_uuid=? and status='running'").all(task.uuid) as any[]) { d.log.emit({ type: "task.status_changed", task_uuid: c.uuid, payload: { status: "done", patch: { status: "done", ended_at: now() } } }); d.permits.release(`agent:${c.agent_id}`); }
      for (const l of d.db.query("select holder_id from permit_leases where task_uuid=? and holder_kind='subagent' and released_at is null").all(task.uuid) as any[]) d.permits.release(l.holder_id);   // provisional Agent leases die with the process
      // Relay's own doing covers `resume` as well as `stop`: the outbox stops the live session before `--bg --resume`
      // forks a new one (Phase 0 ④), so the SessionEnd that follows is expected, not a crash. A resume stays `running`
      // from before that stop until the forked session is on the roster — exactly the window it dies in.
      const ours = !!d.db.query("select 1 from commands where task_uuid=? and ((kind='stop' and (state='running' or (state='applied' and applied_at>=?))) or (kind='resume' and state='running'))").get(task.uuid, now() - 60_000);
      const unexpected = ["starting", "running"].includes(task.status) && !task.paused && !ours;
      const endGen = headerGen ?? gen;                                       // which generation ended: the projection is generation-scoped (I7)
      d.log.emit({ type: "process.ended", task_uuid: task.uuid, process_generation: endGen, payload: { generation: endGen, reason: body.reason ?? "other", crashed: unexpected } });
      if (unexpected) d.onCrash(loadTask(d.db, task.uuid)!, `SessionEnd(${body.reason ?? "other"}) while running`);
      return { status: 200, json: {} };
    }
    default: return { status: 200, json: {} };
  }
}
