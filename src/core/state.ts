// src/core/state.ts — roadmap B2 invariants as SQL checks. Returns human-readable violations (empty = healthy).
import type { Database } from "bun:sqlite";
import type { Task } from "@shared/types.ts";

/** Who is entitled to a task lease: I2's `starting`/`running`, plus I6's exception — a PERMISSION question keeps the
 *  slot, because relay answers it itself and the worker carries straight on in the same turn. `starting`/`running`
 *  alone is a shorter approximation of the same rule, and each place it was written out by hand took the slot off a
 *  worker that was still alive. One definition, read by the scheduler's after-check, permit reconcile and I6. */
export const holdsSlot = (t: Pick<Task, "status" | "question"> | null | undefined) =>
  !!t && (["starting", "running"].includes(t.status) || (t.status === "waiting_input" && t.question?.source === "permission"));
/** The same predicate over a `tasks` row in SQL; `alias` qualifies the columns where the query joins. */
export const HOLDS_SLOT = (alias = "") => {
  const p = alias ? `${alias}.` : "";
  return `(${p}status in ('starting','running') or (${p}status='waiting_input' and json_extract(${p}question_json,'$.source')='permission'))`;
};

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
  // …and the other half of the same rule: the exception is worthless if nothing notices the slot being taken away. A
  // live worker parked on a permission question is occupying an agent slot whatever the status column says, so handing
  // that slot to a second task is how max_concurrent_agents gets exceeded (I1/I2) the moment the answer lands.
  for (const r of q("select uuid from tasks where parent_uuid is null and status='waiting_input' and json_extract(question_json,'$.source')='permission' and process_state in ('starting','alive') and paused=0 and not exists (select 1 from permit_leases l where l.task_uuid=tasks.uuid and l.holder_kind='task' and l.released_at is null)")) out.push(`I6: permission-waiting task ${r.uuid} lost its lease while its worker is still alive`);
  for (const r of q("select uuid from tasks where status='queued' and (queued_at is null or exists (select 1 from permit_leases l where l.task_uuid=tasks.uuid and l.holder_kind='task' and l.released_at is null))")) out.push(`I9: queued task ${r.uuid} has no queued_at or holds a lease`);
  for (const r of q("select task_uuid, count(*) c from commands where state='running' group by task_uuid having c>1")) out.push(`I8: task ${r.task_uuid} has ${r.c} commands running`);
  return out;
}
