import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventEnvelope, Message, Project, SystemState, Task, WsFrame } from "@shared/types.ts";
import type { Config } from "../config.ts";
import { pendingCleanup } from "../lifecycle/cleanup.ts";
import { now } from "./clock.ts";
import { loadGoal, loadGoalMembers, rowToGoalNotificationClaim } from "./goals.ts";

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
export type FrameBody = DistributiveOmit<WsFrame, "seq" | "idx">;   // seq/idx are stamped by EventLog per event
const J = (s: string | null) => (s ? JSON.parse(s) : null);
const sameStrings = (a: unknown, b: string[]) => Array.isArray(a) && JSON.stringify([...new Set(a.map(String))].sort()) === JSON.stringify([...new Set(b)].sort());
function goalEvent(db: Database, ev: EventEnvelope, p: any, expectedTaskUuids?: string[]) {
  if (ev.task_uuid != null) throw new Error(`projection: ${ev.type} must not be task-scoped (retention would delete it)`);
  if (!p.goal_id || !Array.isArray(p.task_uuids)) throw new Error(`projection: invalid ${ev.type} payload`);
  if (expectedTaskUuids && !sameStrings(p.task_uuids, expectedTaskUuids)) throw new Error(`projection: ${ev.type} task UUID snapshot does not match immutable membership`);
  if (new Set(p.task_uuids.map(String)).size !== p.task_uuids.length) throw new Error(`projection: ${ev.type} task UUID snapshot contains duplicates`);
  return (db.query("select * from goals where id=?").get(p.goal_id) as any) ?? null;
}
/** `meta` keys owned by the runtime, not by settings: their own events (or the migrator) are the only writers. */
const PROTECTED_META = new Set(["schema_version", "kill_switch", "recovering", "relay_instance_id"]);

export function rowToTask(r: any): Task {
  const { question_json, summary_json, ...rest } = r;
  return { ...rest, paused: !!r.paused, qhead: !!r.qhead, question: J(question_json), summary_json: J(summary_json) };
}
export const loadTask = (db: Database, uuid: string): Task | null => { const r = db.query("select * from tasks where uuid=?").get(uuid); return r ? { ...rowToTask(r), cleanup_pending: pendingCleanup(db, uuid).length > 0 } : null; };
export const rowToMessage = (r: any): Message => ({ ...r, ask: !!r.ask, dispatch_json: J(r.dispatch_json) });
export const loadMessage = (db: Database, id: string): Message | null => { const r = db.query("select * from messages where id=?").get(id); return r ? rowToMessage(r) : null; };
export const rowToProject = (r: any): Project => ({ ...r, keywords: J(r.keywords_json) ?? [], is_git: !!r.is_git });
export const loadProjects = (db: Database): Project[] => db.query("select * from projects order by name").all().map(rowToProject);

const TASK_COLS = new Set(["project_id","title","status","size","effort","model","session_id","short_id","worktree_path","branch","base_sha","process_state","process_generation","turn_state","attach_state","attached_by","paused","last_summary","last_step","parent_uuid","agent_id","agent_type","queued_at","qhead","started_at","ended_at","updated_at","closed_at","usage_tokens"]);
function patchTask(db: Database, uuid: string, patch: Record<string, unknown>, at: number) {
  const cols = Object.keys(patch).filter((k) => TASK_COLS.has(k) && patch[k] !== undefined);   // an undefined value must never null-out a column
  const sets = cols.map((k) => `${k}=?`); const vals: SQLQueryBindings[] = cols.map((k) => { const v = patch[k]; return (typeof v === "boolean" ? (v ? 1 : 0) : v) as SQLQueryBindings; });
  if ("question" in patch) { sets.push("question_json=?"); vals.push(patch.question ? JSON.stringify(patch.question) : null); }
  sets.push("updated_at=?"); vals.push(at);
  const r = db.run(`update tasks set ${sets.join(",")} where uuid=?`, [...vals, uuid]);
  if (r.changes === 0) throw new Error(`projection: task ${uuid} not found`);
}
const MSG_COLS = new Set(["role","dispatch_state","text","task_uuid","dispatch_json","dispatch_error","chain_prev_id"]);
function patchMessage(db: Database, id: string, patch: Record<string, unknown>) {
  const cols = Object.keys(patch).filter((k) => MSG_COLS.has(k) && patch[k] !== undefined);
  const vals: SQLQueryBindings[] = cols.map((k) => (k === "dispatch_json" && patch[k] && typeof patch[k] === "object" ? JSON.stringify(patch[k]) : patch[k]) as SQLQueryBindings);
  const r = db.run(`update messages set ${cols.map((k) => `${k}=?`).join(",")} where id=?`, [...vals, id]);
  if (r.changes === 0) throw new Error(`projection: message ${id} not found`);
}

export function systemState(db: Database, cfg: Config, extra: Partial<SystemState> = {}, ops: { log_dir?: string; oauth_fallback?: boolean } = {}): SystemState {
  const cnt = (sql: string) => (db.query(sql).get() as any).c as number;
  const meta = (k: string) => (db.query("select value from meta where key=?").get(k) as any)?.value ?? null;
  const dayStart = new Date(now()); dayStart.setHours(0, 0, 0, 0);
  const today = (db.query("select coalesce(sum(json_extract(payload_json,'$.delta')),0) c from events where type='usage.sampled' and occurred_at>=?").get(dayStart.getTime()) as any).c as number;
  return {
    paused: meta("kill_switch") === "1", recovering: meta("recovering") === "1",
    max_concurrent_agents: Number(meta("max_concurrent_agents") ?? cfg.max_concurrent_agents),
    running: cnt("select count(*) c from tasks where status in ('starting','running') and parent_uuid is null"),
    queued: cnt("select count(*) c from tasks where status='queued'"), leases: cnt("select count(*) c from permit_leases where released_at is null"),
    today_tokens: today, daily_ceiling: cfg.usage.daily_ceiling_tokens, delivery_method: (meta("delivery_method") as any) ?? "resume", version: meta("version") ?? "dev",
    log_dir: ops.log_dir ?? meta("log_dir") ?? "", oauth_fallback: ops.oauth_fallback ?? meta("oauth_fallback") === "1", cli_drift: meta("cli_drift") ?? "", ...extra,
  };
}

/** Apply one event to the projections. Returns the WS frame bodies to broadcast (seq is stamped by EventLog). Throws to roll back. */
export function applyProjection(db: Database, ev: EventEnvelope, cfg: Config): FrameBody[] {
  const p: any = ev.payload ?? {}; const at = ev.recorded_at; const frames: FrameBody[] = [];
  // An event without a task (or naming one that is gone) must not put `task: null` on the wire — the dashboard reads
  // `task.uuid` on every frame. Such an event is still recorded; it just projects nothing.
  const taskFrame = (uuid: string | null) => { const t = uuid ? loadTask(db, uuid) : null; if (t) frames.push({ type: "task.updated", task: t }); };
  const msgFrame = (id: string, chat = false) => { const m = loadMessage(db, id)!; frames.push({ type: "dispatch.updated", message: m }); if (chat) frames.push({ type: "chat.message", message: m }); };
  const state = () => frames.push({ type: "system.state", state: systemState(db, cfg) });
  const goalFrame = (id: string, members = false) => { const goal = loadGoal(db, id); if (goal) frames.push({ type: "goal.updated", goal, ...(members ? { members: loadGoalMembers(db, id) } : {}) }); };
  const claimFrame = (id: string) => { const r = db.query("select * from goal_notification_claims where claim_id=?").get(id); if (r) frames.push({ type: "goal.notification", claim: rowToGoalNotificationClaim(r) }); };
  switch (true) {
    case ev.type === "goal.created": {
      goalEvent(db, ev, p);
      if (!p.request || p.request.message_id == null || typeof p.request.text !== "string" || !Array.isArray(p.members) || !p.members.length) throw new Error("projection: invalid goal.created payload");
      const taskUuids = p.members.map((m: any) => String(m.task_uuid));
      if (!sameStrings(p.task_uuids, taskUuids)) throw new Error("projection: goal.created task UUID snapshot does not match members");
      const items = new Set<string>(); const ordinals = new Set<number>();
      for (const m of p.members) {
        if (!m.split_item_id || !m.task_uuid || !m.task_display_id || !Number.isInteger(m.ordinal) || m.ordinal < 0) throw new Error("projection: invalid goal member");
        if (items.has(m.split_item_id) || ordinals.has(m.ordinal)) throw new Error("projection: duplicate goal member identity");
        items.add(m.split_item_id); ordinals.add(m.ordinal);
      }
      const requestJson = JSON.stringify(p.request); const existing = db.query("select * from goals where id=?").get(p.goal_id) as any;
      if (existing) {
        const currentMembers = db.query("select split_item_id,ordinal,task_uuid,task_display_id from goal_members where goal_id=? order by ordinal").all(p.goal_id);
        const declaredMembers = p.members.map((m: any) => ({ split_item_id: m.split_item_id, ordinal: m.ordinal, task_uuid: m.task_uuid, task_display_id: m.task_display_id }));
        if (existing.request_message_id !== p.request.message_id || existing.original_request_json !== requestJson || JSON.stringify(currentMembers) !== JSON.stringify(declaredMembers)) throw new Error(`projection: goal ${p.goal_id} was redeclared differently`);
        break;
      }
      db.run("insert into goals(id,request_message_id,original_request_json,status,current_generation,created_at,updated_at) values(?,?,?,'active',1,?,?)", [p.goal_id, p.request.message_id, requestJson, at, at]);
      db.run("insert into goal_cycles(goal_id,generation,status,opened_at) values(?,1,'active',?)", [p.goal_id, at]);
      for (const m of p.members) db.run("insert into goal_members(goal_id,split_item_id,ordinal,task_uuid,task_display_id,created_at) values(?,?,?,?,?,?)", [p.goal_id, m.split_item_id, m.ordinal, m.task_uuid, m.task_display_id, at]);
      goalFrame(p.goal_id, true);
      break;
    }
    case ev.type === "goal.reopened": {
      const g = goalEvent(db, ev, p, (db.query("select distinct task_uuid from goal_members where goal_id=? order by task_uuid").all(p.goal_id) as any[]).map((r) => r.task_uuid));
      if (!g || !Number.isInteger(p.generation) || p.generation < 2) throw new Error("projection: invalid goal.reopened payload");
      if (g.current_generation === p.generation && g.status === "active") break; // exact logical retry
      if (g.status !== "completed" || p.generation !== g.current_generation + 1) throw new Error(`projection: goal ${p.goal_id} cannot reopen at generation ${p.generation}`);
      const priorClaim = db.query("select claim_id from goal_notification_claims where goal_id=? and generation=?").get(p.goal_id, g.current_generation) as { claim_id: string } | null;
      db.run("update goal_notification_claims set state='superseded',resolved_at=coalesce(resolved_at,?) where goal_id=? and generation=? and state='pending'", [at, p.goal_id, g.current_generation]);
      db.run("insert into goal_cycles(goal_id,generation,status,opened_at) values(?,?,'active',?)", [p.goal_id, p.generation, at]);
      db.run("update goals set status='active',current_generation=?,outcome=null,completed_at=null,review_due_at=null,reviewed_at=null,updated_at=? where id=?", [p.generation, at, p.goal_id]);
      if (priorClaim) claimFrame(priorClaim.claim_id); // explicit retry consumes the earlier completion notice
      goalFrame(p.goal_id);
      break;
    }
    case ev.type === "goal.completed": {
      const expected = (db.query("select distinct task_uuid from goal_members where goal_id=? order by task_uuid").all(p.goal_id) as any[]).map((r) => r.task_uuid);
      const g = goalEvent(db, ev, p, expected);
      if (!g || !Number.isInteger(p.generation) || !["completed","completed_with_cancellations","cancelled"].includes(p.outcome) || !p.notification_claim_id || !Array.isArray(p.member_states) || typeof p.review_after_ms !== "number" || !Number.isFinite(p.review_after_ms) || p.review_after_ms < 0) throw new Error("projection: invalid goal.completed payload");
      const members = db.query("select split_item_id,task_uuid,task_display_id from goal_members where goal_id=? order by ordinal").all(p.goal_id) as any[];
      const declared = p.member_states;
      if (members.length !== declared.length) throw new Error("projection: goal completion does not cover every immutable member");
      let cancelled = 0;
      for (let i = 0; i < members.length; i++) {
        const a = members[i], b = declared[i];
        if (a.split_item_id !== b?.split_item_id || a.task_uuid !== b?.task_uuid || a.task_display_id !== b?.task_display_id || !["done","cancelled"].includes(b?.status)) throw new Error("projection: goal completion member snapshot does not match membership");
        if (b.status === "cancelled") cancelled++;
      }
      const outcome = cancelled === 0 ? "completed" : cancelled === members.length ? "cancelled" : "completed_with_cancellations";
      if (p.outcome !== outcome) throw new Error("projection: goal completion outcome does not match member states");
      if (g.current_generation !== p.generation) throw new Error(`projection: stale goal completion generation ${p.generation}`);
      if (g.status === "completed") {
        const old = db.query("select * from goal_notification_claims where goal_id=? and generation=?").get(p.goal_id, p.generation) as any;
        const cycle = db.query("select member_states_json from goal_cycles where goal_id=? and generation=?").get(p.goal_id, p.generation) as any;
        if (g.outcome !== p.outcome || !old || old.claim_id !== p.notification_claim_id || cycle?.member_states_json !== JSON.stringify(p.member_states)) throw new Error(`projection: goal ${p.goal_id} generation ${p.generation} completed twice differently`);
        goalFrame(p.goal_id); claimFrame(old.claim_id); break;
      }
      db.run("update goal_cycles set status='completed',outcome=?,completed_at=?,member_states_json=? where goal_id=? and generation=? and status='active'", [p.outcome, at, JSON.stringify(p.member_states), p.goal_id, p.generation]);
      db.run("update goals set status='completed',outcome=?,completed_at=?,review_due_at=?,updated_at=? where id=?", [p.outcome, at, at + p.review_after_ms, at, p.goal_id]);
      db.run("insert into goal_notification_claims(claim_id,goal_id,generation,outcome,task_uuids_json,claimed_at,completion_event_id) values(?,?,?,?,?,?,?)", [p.notification_claim_id, p.goal_id, p.generation, p.outcome, JSON.stringify(p.task_uuids), at, ev.event_id]);
      goalFrame(p.goal_id); claimFrame(p.notification_claim_id);
      break;
    }
    case ev.type === "goal.reviewed": {
      const expected = (db.query("select distinct task_uuid from goal_members where goal_id=? order by task_uuid").all(p.goal_id) as any[]).map((r) => r.task_uuid);
      const g = goalEvent(db, ev, p, expected);
      if (!g || g.status !== "completed" || p.generation !== g.current_generation) throw new Error("projection: only the current completed goal generation can be reviewed");
      db.run("update goals set reviewed_at=coalesce(reviewed_at,?),updated_at=max(updated_at,?) where id=?", [at, at, p.goal_id]);
      db.run("update goal_notification_claims set state='reviewed',resolved_at=coalesce(resolved_at,?) where goal_id=? and generation=? and state='pending'", [at, p.goal_id, p.generation]);
      goalFrame(p.goal_id);
      const claim = db.query("select claim_id from goal_notification_claims where goal_id=? and generation=?").get(p.goal_id, p.generation) as { claim_id: string } | null;
      if (claim) claimFrame(claim.claim_id);
      break;
    }
    case ev.type === "goal.notification_delivered": {
      const expected = (db.query("select distinct task_uuid from goal_members where goal_id=? order by task_uuid").all(p.goal_id) as any[]).map((r) => r.task_uuid);
      goalEvent(db, ev, p, expected);
      const claim = db.query("select * from goal_notification_claims where claim_id=?").get(p.claim_id) as any;
      if (!claim || claim.goal_id !== p.goal_id || claim.generation !== p.generation) throw new Error("projection: notification delivery does not match its durable claim");
      db.run("update goal_notification_claims set state='delivered',delivered_at=coalesce(delivered_at,?),resolved_at=coalesce(resolved_at,?) where claim_id=? and state='pending'", [at, at, p.claim_id]);
      claimFrame(p.claim_id);
      break;
    }
    case ev.type === "task.created": {
      const t = p as Task;
      db.run(`insert into tasks(uuid,num,display_id,project_id,title,status,size,effort,model,session_id,short_id,worktree_path,branch,base_sha,process_state,process_generation,turn_state,attach_state,attached_by,paused,last_summary,last_step,question_json,parent_uuid,agent_id,agent_type,queued_at,qhead,started_at,ended_at,created_at,updated_at,closed_at,usage_tokens)
        values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [t.uuid,t.num,t.display_id,t.project_id,t.title,t.status,t.size,t.effort,t.model,t.session_id,t.short_id,t.worktree_path,t.branch,t.base_sha,t.process_state,t.process_generation,t.turn_state,t.attach_state,t.attached_by,t.paused?1:0,t.last_summary,t.last_step,t.question?JSON.stringify(t.question):null,t.parent_uuid,t.agent_id,t.agent_type,t.queued_at,t.qhead?1:0,t.started_at,t.ended_at,t.created_at,t.updated_at,t.closed_at,t.usage_tokens]);
      frames.push({ type: "task.created", task: loadTask(db, t.uuid)! }); state(); break;
    }
    case ev.type.startsWith("task.") || ev.type.startsWith("question.") || ev.type.startsWith("attach.") || ev.type === "idle.deadline": {
      if (p.patch) patchTask(db, ev.task_uuid!, p.patch, at);
      taskFrame(ev.task_uuid!); if (ev.type === "task.status_changed") state(); break;
    }
    case ev.type === "process.started": {
      // idempotent per generation: a watchdog-detected start followed by the real SessionStart must not open a second instance (I4)
      const open = db.query("select id, generation from process_instances where task_uuid=? and ended_at is null").get(ev.task_uuid) as any;
      if (open && open.generation === p.generation) db.run("update process_instances set short_id=coalesce(?,short_id), session_id=coalesce(?,session_id), pid=coalesce(?,pid) where id=?", [p.short_id ?? null, p.session_id ?? null, p.pid ?? null, open.id]);
      else { if (open) db.run("update process_instances set ended_at=?, end_reason='superseded' where id=?", [at, open.id]); db.run("insert into process_instances(id,task_uuid,short_id,session_id,pid,generation,started_at) values(?,?,?,?,?,?,?)", [ev.event_id, ev.task_uuid, p.short_id ?? null, p.session_id ?? null, p.pid ?? null, p.generation, at]); }
      patchTask(db, ev.task_uuid!, { process_state: "alive", process_generation: p.generation, short_id: p.short_id ?? undefined, session_id: p.session_id ?? undefined, ...(p.patch ?? {}) }, at);
      taskFrame(ev.task_uuid!); break;
    }
    case ev.type === "process.ended": {
      // Scoped by generation like process.started: the supervisor restarts `--bg` sessions (roadmap C1), so a SessionEnd
      // from a superseded process arrives after the next one is already alive. Applying it would close the live instance
      // and mark the task stopped (breaks I4 and I7).
      const gen = (p.generation ?? ev.process_generation) as number | null;
      const cur = (db.query("select process_generation from tasks where uuid=?").get(ev.task_uuid) as any)?.process_generation ?? 0;
      if (gen != null && gen < cur) break;                                 // recorded in events, no projection
      db.run(`update process_instances set ended_at=?, end_reason=? where task_uuid=? and ended_at is null${gen != null ? " and generation=?" : ""}`,
        gen != null ? [at, p.reason ?? null, ev.task_uuid, gen] : [at, p.reason ?? null, ev.task_uuid]);
      patchTask(db, ev.task_uuid!, { process_state: p.crashed ? "crashed" : "stopped", turn_state: "idle", ...(p.patch ?? {}) }, at);
      taskFrame(ev.task_uuid!); break;
    }
    case ev.type === "permit.acquired": db.run("insert into permit_leases(id,holder_kind,holder_id,task_uuid,acquired_at,reason) values(?,?,?,?,?,?)", [p.lease_id, p.holder_kind, p.holder_id, ev.task_uuid, at, p.reason ?? null]); state(); break;
    case ev.type === "permit.released": db.run("update permit_leases set released_at=? where holder_id=? and released_at is null", [at, p.holder_id]); state(); break;
    case ev.type === "permit.rebound": db.run("update permit_leases set holder_id=? where holder_id=? and released_at is null", [p.to, p.from]); break;
    case ev.type === "message.received": {
      const m = p as Message;
      // Upcast: events emitted before `ask` existed carried Ask mode as a "? " prefix, and `markAsk` made that exactly
      // one "? " — so this is the literal, not `isAsk`. A wider match would claim "?fix the parser", which is a
      // verbatim work body that migration 2 correctly leaves 0; the two predicates must stay the same predicate.
      // New events always carry the field (routes.ts is the only role='user' producer), so `undefined` means pre-0.1.3
      // and nothing else. An emitter that omits `ask` on a role='user' message would land here as a text sniff.
      const ask = m.ask ?? (m.role === "user" && m.text.startsWith("? "));
      db.run("insert into messages(id,role,source,client_message_id,dispatch_state,text,task_uuid,reply_to_task_uuid,ask,dispatch_json,dispatch_error,chain_prev_id,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [m.id, m.role, m.source, m.client_message_id, m.dispatch_state, m.text, m.task_uuid, m.reply_to_task_uuid, ask ? 1 : 0, m.dispatch_json ? JSON.stringify(m.dispatch_json) : null, m.dispatch_error, m.chain_prev_id ?? null, m.created_at]);
      frames.push({ type: "chat.message", message: loadMessage(db, m.id)! }); if (m.role === "user") frames.push({ type: "dispatch.updated", message: loadMessage(db, m.id)! }); break;
    }
    case ev.type.startsWith("dispatch."): { if (p.patch) patchMessage(db, p.message_id, p.patch); msgFrame(p.message_id, !!p.chat); break; }
    case ev.type === "command.queued": db.run("insert or ignore into commands(id,task_uuid,kind,payload_json,created_at) values(?,?,?,?,?)", [p.id, ev.task_uuid, p.kind, JSON.stringify(p.payload ?? {}), at]); if (ev.task_uuid) taskFrame(ev.task_uuid); break;
    case ev.type === "command.running": db.run("update commands set state='running', attempts=attempts+1 where id=?", [p.id]); break;
    case ev.type === "command.applied": db.run("update commands set state='applied', applied_at=? where id=?", [at, p.id]); if (ev.task_uuid) taskFrame(ev.task_uuid); break;   // command state changes reach the dashboard as task.updated (§4)
    case ev.type === "command.failed": db.run("update commands set state='failed', error=? where id=?", [p.error ?? null, p.id]); if (ev.task_uuid) taskFrame(ev.task_uuid); break;
    case ev.type === "command.unknown": db.run("update commands set state='unknown', error=? where id=?", [p.error ?? null, p.id]); if (ev.task_uuid) taskFrame(ev.task_uuid); break;
    case ev.type === "command.requeued": db.run("update commands set state='pending', error=null where id=?", [p.id]); if (ev.task_uuid) taskFrame(ev.task_uuid); break;
    case ev.type === "retention.swept": if (ev.task_uuid) db.run("update tasks set summary_json=?, updated_at=? where uuid=?", [JSON.stringify(p.summary), at, ev.task_uuid]); break;
    case ev.type === "system.paused": db.run("insert into meta(key,value) values('kill_switch','1') on conflict(key) do update set value='1'"); state(); break;
    case ev.type === "system.resumed": db.run("insert into meta(key,value) values('kill_switch','0') on conflict(key) do update set value='0'"); state(); break;
    case ev.type === "settings.changed":                                    // never let a settings payload reach the keys that carry invariants — `schema_version` alone would silently disable every future migration
      for (const [k, v] of Object.entries(p)) { if (PROTECTED_META.has(k)) continue; db.run("insert into meta(key,value) values(?,?) on conflict(key) do update set value=excluded.value", [k, String(v)]); }
      state(); break;
    case ev.type === "project.registered": {
      const pr = p as Project;
      db.run("insert into projects(id,name,path,description,keywords_json,base_ref,is_git,created_at) values(?,?,?,?,?,?,?,?) on conflict(id) do update set name=excluded.name,path=excluded.path,description=excluded.description,keywords_json=excluded.keywords_json,base_ref=excluded.base_ref,is_git=excluded.is_git",
        [pr.id, pr.name, pr.path, pr.description, JSON.stringify(pr.keywords), pr.base_ref, pr.is_git ? 1 : 0, at]);
      frames.push({ type: "projects.updated", projects: loadProjects(db) }); break;
    }
    case ev.type === "project.removed": db.run("delete from projects where id=?", [p.id]); frames.push({ type: "projects.updated", projects: loadProjects(db) }); break;
    case ev.type === "usage.sampled": { if (ev.task_uuid) { db.run("update tasks set usage_tokens=usage_tokens+?, updated_at=? where uuid=?", [p.delta ?? 0, at, ev.task_uuid]); taskFrame(ev.task_uuid); } state(); break; }
    default: /* hook.*, send.outcome, message.sent: stream only (+ dispatch.updated when a send outcome belongs to a chat message) */
      if (ev.task_uuid) { if (p.patch) { patchTask(db, ev.task_uuid, p.patch, at); taskFrame(ev.task_uuid); } frames.push({ type: "task.event", task_uuid: ev.task_uuid, event: ev }); }
      if (ev.type === "send.outcome" && p.message_id && loadMessage(db, p.message_id)) { if (p.outcome === "refused") patchMessage(db, p.message_id, { dispatch_error: "delivery refused" }); msgFrame(p.message_id); }
  }
  return frames;
}
