import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventEnvelope, Message, Project, SystemState, Task, WsFrame } from "@shared/types.ts";
import type { Config } from "../config.ts";
import { now } from "./clock.ts";

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
export type FrameBody = DistributiveOmit<WsFrame, "seq" | "idx">;   // seq/idx are stamped by EventLog per event
const J = (s: string | null) => (s ? JSON.parse(s) : null);

export function rowToTask(r: any): Task {
  const { question_json, summary_json, ...rest } = r;
  return { ...rest, paused: !!r.paused, qhead: !!r.qhead, question: J(question_json), summary_json: J(summary_json) };
}
export const loadTask = (db: Database, uuid: string): Task | null => { const r = db.query("select * from tasks where uuid=?").get(uuid); return r ? rowToTask(r) : null; };
export const rowToMessage = (r: any): Message => ({ ...r, dispatch_json: J(r.dispatch_json) });
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
    log_dir: ops.log_dir ?? meta("log_dir") ?? "", oauth_fallback: ops.oauth_fallback ?? meta("oauth_fallback") === "1", ...extra,
  };
}

/** Apply one event to the projections. Returns the WS frame bodies to broadcast (seq is stamped by EventLog). Throws to roll back. */
export function applyProjection(db: Database, ev: EventEnvelope, cfg: Config): FrameBody[] {
  const p: any = ev.payload ?? {}; const at = ev.recorded_at; const frames: FrameBody[] = [];
  const taskFrame = (uuid: string) => frames.push({ type: "task.updated", task: loadTask(db, uuid)! });
  const msgFrame = (id: string, chat = false) => { const m = loadMessage(db, id)!; frames.push({ type: "dispatch.updated", message: m }); if (chat) frames.push({ type: "chat.message", message: m }); };
  const state = () => frames.push({ type: "system.state", state: systemState(db, cfg) });
  switch (true) {
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
      db.run("update process_instances set ended_at=?, end_reason=? where task_uuid=? and ended_at is null", [at, p.reason ?? null, ev.task_uuid]);
      patchTask(db, ev.task_uuid!, { process_state: p.crashed ? "crashed" : "stopped", turn_state: "idle", ...(p.patch ?? {}) }, at);
      taskFrame(ev.task_uuid!); break;
    }
    case ev.type === "permit.acquired": db.run("insert into permit_leases(id,holder_kind,holder_id,task_uuid,acquired_at,reason) values(?,?,?,?,?,?)", [p.lease_id, p.holder_kind, p.holder_id, ev.task_uuid, at, p.reason ?? null]); state(); break;
    case ev.type === "permit.released": db.run("update permit_leases set released_at=? where holder_id=? and released_at is null", [at, p.holder_id]); state(); break;
    case ev.type === "permit.rebound": db.run("update permit_leases set holder_id=? where holder_id=? and released_at is null", [p.to, p.from]); break;
    case ev.type === "message.received": {
      const m = p as Message;
      db.run("insert into messages(id,role,source,client_message_id,dispatch_state,text,task_uuid,reply_to_task_uuid,dispatch_json,dispatch_error,chain_prev_id,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?)",
        [m.id, m.role, m.source, m.client_message_id, m.dispatch_state, m.text, m.task_uuid, m.reply_to_task_uuid, m.dispatch_json ? JSON.stringify(m.dispatch_json) : null, m.dispatch_error, m.chain_prev_id ?? null, m.created_at]);
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
    case ev.type === "settings.changed": for (const [k, v] of Object.entries(p)) db.run("insert into meta(key,value) values(?,?) on conflict(key) do update set value=excluded.value", [k, String(v)]); state(); break;
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
      if (ev.type === "send.outcome" && p.message_id && loadMessage(db, p.message_id)) { if (p.outcome === "refused") patchMessage(db, p.message_id, { dispatch_error: "전달 거부(refused)" }); msgFrame(p.message_id); }
  }
  return frames;
}
