// src/lifecycle/recovery.ts — startup barrier (§5.6 / §11).
import type { Database } from "bun:sqlite";
import { now } from "../core/clock.ts";
import { EventLog, rowToTask, systemState } from "../core/events.ts";
import type { PermitPool } from "../core/permits.ts";
import type { Scheduler } from "../core/queue.ts";
import type { TaskService } from "../core/tasks.ts";
import { chatFor } from "../core/promote.ts";
import { assertInvariants } from "../core/state.ts";
import type { Dispatcher } from "../dispatcher/dispatcher.ts";
import type { AgentRow, AgentRunner } from "../runner/runner.ts";
import { readOwner, type Outbox } from "./outbox.ts";
import { ingestHook } from "../hooks/ingest.ts";
import { drainInbox } from "../hooks/inbox.ts";
import { setMeta } from "../db/db.ts";
import { log as slog } from "../log.ts";
export interface RecoveryReport { reconciled: number; crashed: string[]; adopted: string[]; requeued: string[]; orphans: string[]; commands: { requeued: string[]; unknown: string[] }; inboxDrained: number; leasesReleased: string[]; invariants: string[] }
/** Ours = the roster row's cwd carries our owner stamp for this task (name/short id alone are not proof — roadmap B8/§6.3). */
const ownedBy = (row: AgentRow, taskUuid: string, instanceId: string) => { const o = readOwner(row.cwd); return !!o && o.task_uuid === taskUuid && o.relay_instance_id === instanceId; };
export async function recover(d: { db: Database; log: EventLog; runner: AgentRunner; permits: PermitPool; outbox: Outbox; dispatcher: Dispatcher; scheduler: Scheduler; tasks: TaskService; spool: { drain(): Promise<unknown> }; maxAgents: () => number; instanceId: () => string }): Promise<RecoveryReport> {
  setMeta(d.db, "recovering", "1"); const report: RecoveryReport = { reconciled: 0, crashed: [], adopted: [], requeued: [], orphans: [], commands: { requeued: [], unknown: [] }, inboxDrained: 0, leasesReleased: [], invariants: [] };
  let rows: AgentRow[] | null = null;
  for (let i = 0; i < 3 && !rows; i++) { try { rows = await d.runner.list(true); } catch (e) { slog.warn("agents --json failed during recovery", { attempt: i + 1, e: String(e) }); await Bun.sleep(1000); } }
  if (!rows) { slog.error("recovery: agents --json unavailable — leaving tasks untouched, staying in recovering mode"); return report; }   // watchdog keeps retrying; hooks keep buffering (durably)
  const aliveIds = new Set(rows.filter((r) => r.alive && r.session_id).map((r) => r.session_id!));
  const takenSession = (sid: string, uuid: string) => !!d.db.query("select 1 from tasks where session_id=? and uuid<>?").get(sid, uuid);
  // ① ownership / process state for every non-closed task
  for (const t of d.db.query("select * from tasks where parent_uuid is null and status!='closed'").all().map(rowToTask)) {
    report.reconciled++;
    const row = rows.find((r) => (t.session_id && r.session_id === t.session_id) || (t.short_id && r.short_id === t.short_id) || (!t.session_id && ownedBy(r, t.uuid, d.instanceId())));
    const patch: Record<string, unknown> = {};                                   // attach_state is kept: a user may still be in the terminal (watchdog releases stale leases)
    const pendingSpawn = !!d.db.query("select 1 from commands where task_uuid=? and kind='spawn' and state in ('pending','running')").get(t.uuid);
    if (row?.alive) {
      patch.process_state = "alive"; if (row.short_id) patch.short_id = row.short_id;
      // `--bg --resume` forks the session id but keeps our short id (phase 0 `resumeForksSessionId`) — follow the chain instead of calling it dead
      if (row.session_id && row.session_id !== t.session_id && !takenSession(row.session_id, t.uuid)) { patch.session_id = row.session_id; if (!t.session_id) report.adopted.push(t.uuid); }
      if (t.status === "starting") { patch.status = "running"; patch.started_at = t.started_at ?? now(); }
    }
    else if (pendingSpawn && t.status === "starting") { patch.status = "queued"; patch.process_state = "none"; patch.queued_at = t.queued_at ?? now(); patch.qhead = true; report.requeued.push(t.uuid); }   // never ran: let the scheduler grant the slot again
    else if (["starting", "alive"].includes(t.process_state)) {
      const crashed = ["starting", "running"].includes(t.status) && !t.paused;
      d.log.emit({ type: "process.ended", task_uuid: t.uuid, process_generation: t.process_generation, payload: { generation: t.process_generation, reason: "recovery: not in agents list", crashed } });
      if (crashed) { patch.status = "error"; patch.ended_at = now(); report.crashed.push(t.uuid); d.log.emit({ type: "message.received", task_uuid: t.uuid, payload: chatFor("error", t, "The session vanished while relay restarted — use Restart to --resume") }); }
    }
    if (patch.status) d.log.emit({ type: "task.status_changed", task_uuid: t.uuid, payload: { status: patch.status, patch } });
    else if (Object.keys(patch).length) d.log.emit({ type: "task.patched", task_uuid: t.uuid, payload: { patch } });
  }
  // ② sessions we own that belong to closed/cancelled tasks but are still alive (crash between the status write and stop/rm) → stop + rm
  for (const t of d.db.query("select * from tasks where parent_uuid is null and status in ('closed','cancelled')").all().map(rowToTask)) {
    const row = rows.find((r) => r.alive && ((t.session_id && r.session_id === t.session_id) || ownedBy(r, t.uuid, d.instanceId())));
    // A closed task's earlier generations are orphans too, and `tasks.session_id` names none of them: every fork
    // overwrote it. process_instances is the only record that they existed.
    const superseded = new Set(d.outbox.supersededSessions(t).map((s) => s.session_id));
    const strays = rows.some((r) => r.alive && r.session_id && superseded.has(r.session_id));
    if (!row && !strays) continue;
    report.orphans.push(t.uuid);
    if (row && !d.db.query("select 1 from commands where task_uuid=? and kind='stop' and state in ('pending','running')").get(t.uuid)) d.outbox.enqueue(t.uuid, `recovery-stop:${now()}`, { kind: "stop", reason: "recovery: orphan session" });
    if (row && t.status === "closed" && !d.db.query("select 1 from commands where task_uuid=? and kind='rm' and state in ('pending','running')").get(t.uuid)) d.outbox.enqueue(t.uuid, `recovery-rm:${now()}`, { kind: "rm" });
    d.outbox.reap(t, "recovery: superseded generation", t.status === "closed");   // same rule as the rm two lines up: a cancelled task keeps its worktree on purpose
  }
  for (const c of d.db.query("select uuid, agent_id from tasks where parent_uuid is not null and status='running'").all() as any[]) { const parent = d.db.query("select process_state from tasks where uuid=(select parent_uuid from tasks where uuid=?)").get(c.uuid) as any; if (parent?.process_state !== "alive") { d.log.emit({ type: "task.status_changed", task_uuid: c.uuid, payload: { status: "done", patch: { status: "done", ended_at: now() } } }); d.permits.release(`agent:${c.agent_id}`, "recovery"); } }
  // ③ permits
  report.leasesReleased = d.permits.reconcile(aliveIds);
  for (const t of d.db.query("select uuid from tasks where parent_uuid is null and status in ('starting','running') and paused=0").all() as any[]) {
    if (!d.permits.acquire({ holder_kind: "task", holder_id: `task:${t.uuid}`, task_uuid: t.uuid, reason: "recovery" })) d.scheduler.enqueue(t.uuid, true);
  }
  // ④ commands interrupted by the crash (B3 crash points)
  report.commands = d.outbox.reconcileRunning();
  // ⑤ replay everything that arrived while we were down/reconciling (durable inbox + spool); new arrivals keep buffering until the flag drops
  report.inboxDrained = drainInbox(d.db, (body, headers) => { try { ingestHook(body, headers, d.tasks.ingestDeps, { replay: true }); } catch (e) { slog.warn("inbox drain failed", { e: String(e) }); } });
  await d.spool.drain();
  setMeta(d.db, "recovering", "0");
  // ⑥ resume work
  await d.outbox.runAll(); d.dispatcher.drainPending(); void d.scheduler.pump();
  report.invariants = assertInvariants(d.db, d.maxAgents());
  for (const v of report.invariants) slog.warn("invariant violated after recovery", { v });
  d.log.emit({ type: "system.recovered", payload: report });
  slog.info("recovered", { ...report, state: systemState(d.db, d.log.cfg) });
  return report;
}
