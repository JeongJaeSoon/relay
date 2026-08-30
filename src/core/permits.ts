import type { Database } from "bun:sqlite";
import { EventLog } from "./events.ts";
import { ulid } from "./ids.ts";

interface Holder { holder_kind: "task" | "subagent"; holder_id: string; task_uuid: string; reason?: string }

export class PermitPool {
  constructor(private db: Database, private log: EventLog, private max: () => number, private opts: { subagentPerTask: number | null } = { subagentPerTask: null }) {}
  active(): number { return (this.db.query("select count(*) c from permit_leases where released_at is null").get() as any).c; }
  has(holderId: string) { return !!this.db.query("select 1 from permit_leases where holder_id=? and released_at is null").get(holderId); }
  /** Bun's sqlite API is synchronous, so count + insert cannot interleave with another acquire. */
  acquire(h: Holder): boolean {
    if (this.has(h.holder_id)) return true;
    if (this.active() >= this.max()) return false;
    if (h.holder_kind === "subagent" && this.opts.subagentPerTask != null) {
      const n = (this.db.query("select count(*) c from permit_leases where task_uuid=? and holder_kind='subagent' and released_at is null").get(h.task_uuid) as any).c;
      if (n >= this.opts.subagentPerTask) return false;
    }
    this.log.emit({ type: "permit.acquired", task_uuid: h.task_uuid, payload: { lease_id: ulid(), holder_kind: h.holder_kind, holder_id: h.holder_id, reason: h.reason ?? null } });
    return true;
  }
  release(holderId: string, reason = "released") { if (this.has(holderId)) { const t = this.db.query("select task_uuid from permit_leases where holder_id=? and released_at is null").get(holderId) as any; this.log.emit({ type: "permit.released", task_uuid: t?.task_uuid ?? null, payload: { holder_id: holderId, reason } }); } }
  /** Rename an active lease (PreToolUse(Agent) lease → SubagentStart agent_id). Goes through emit like every other lease change. */
  rebind(from: string, to: string) { if (this.has(from)) { const t = this.db.query("select task_uuid from permit_leases where holder_id=? and released_at is null").get(from) as any; this.log.emit({ type: "permit.rebound", task_uuid: t?.task_uuid ?? null, payload: { from, to } }); } }
  /** Oldest subagent lease of a task that SubagentStart has not yet bound to an agent_id (holder `sub:<task>:<tool_use_id>`). */
  firstUnbound(taskUuid: string): string | null { return (this.db.query("select holder_id from permit_leases where task_uuid=? and holder_kind='subagent' and released_at is null and holder_id like 'sub:%' order by acquired_at asc limit 1").get(taskUuid) as any)?.holder_id ?? null; }
  releaseTask(taskUuid: string, reason = "task ended") { for (const r of this.db.query("select holder_id from permit_leases where task_uuid=? and released_at is null").all(taskUuid) as any[]) this.release(r.holder_id, reason); }
  /** B5 recovery order: dead sessions → leases whose task is not running. Returns released holder ids. */
  reconcile(aliveSessionIds: Set<string>): string[] {
    const out: string[] = [];
    const rows = this.db.query("select l.holder_id, l.holder_kind, t.session_id, t.status, t.paused from permit_leases l join tasks t on t.uuid=l.task_uuid where l.released_at is null").all() as any[];
    for (const r of rows) if (r.session_id && !aliveSessionIds.has(r.session_id)) { this.release(r.holder_id, "session dead"); out.push(r.holder_id); }
    for (const r of rows) if (!out.includes(r.holder_id) && r.holder_kind === "task" && !["starting", "running"].includes(r.status)) { this.release(r.holder_id, "task not running"); out.push(r.holder_id); }
    return out;
  }
}
