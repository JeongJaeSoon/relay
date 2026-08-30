// src/core/state.ts — roadmap B2 invariants as SQL checks. Returns human-readable violations (empty = healthy).
import type { Database } from "bun:sqlite";

export function assertInvariants(db: Database, max: number): string[] {
  const out: string[] = [];
  const q = (sql: string, ...args: any[]) => db.query(sql).all(...args) as any[];
  const active = (db.query("select count(*) c from permit_leases where released_at is null").get() as any).c as number;
  if (active > max) out.push(`I1: active leases ${active} > max ${max}`);
  for (const r of q("select uuid from tasks where parent_uuid is null and status in ('starting','running') and paused=0 and not exists (select 1 from permit_leases l where l.task_uuid=tasks.uuid and l.holder_kind='task' and l.released_at is null)")) out.push(`I2: ${r.uuid} running without a task lease`);
  for (const r of q("select task_uuid, count(*) c from process_instances where ended_at is null group by task_uuid having c>1")) out.push(`I4: task ${r.task_uuid} has ${r.c} open process instances`);
  for (const r of q("select uuid from tasks where status='closed' and (process_state='alive' or exists (select 1 from permit_leases l where l.task_uuid=tasks.uuid and l.released_at is null) or exists (select 1 from commands c where c.task_uuid=tasks.uuid and c.state in ('pending','running')))")) out.push(`I5: closed task ${r.uuid} still has process/lease/pending commands`);
  // I6: waiting_input holds no task lease — except a permission question, where the worker resumes the instant relay answers (roadmap B4 note)
  for (const r of q("select uuid from tasks where status='waiting_input' and coalesce(json_extract(question_json,'$.source'),'') <> 'permission' and exists (select 1 from permit_leases l where l.task_uuid=tasks.uuid and l.holder_kind='task' and l.released_at is null)")) out.push(`I6: waiting task ${r.uuid} holds a lease`);
  for (const r of q("select uuid from tasks where status='queued' and (queued_at is null or exists (select 1 from permit_leases l where l.task_uuid=tasks.uuid and l.holder_kind='task' and l.released_at is null))")) out.push(`I9: queued task ${r.uuid} has no queued_at or holds a lease`);
  for (const r of q("select task_uuid, count(*) c from commands where state='running' group by task_uuid having c>1")) out.push(`I8: task ${r.task_uuid} has ${r.c} commands running`);
  return out;
}
