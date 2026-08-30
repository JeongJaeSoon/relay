// src/lifecycle/watchdog.ts — 5s roster poll (§5.6): the only way relay learns about a process it never got a hook for.
import type { Database } from "bun:sqlite";
import { now } from "../core/clock.ts";
import { EventLog, loadTask, rowToTask } from "../core/events.ts";
import { chatFor } from "../core/promote.ts";
import type { PermitPool } from "../core/permits.ts";
import type { TaskService } from "../core/tasks.ts";
import type { AgentRow, AgentRunner } from "../runner/runner.ts";
import type { ForeignSessions } from "./foreign.ts";
import { log as slog } from "../log.ts";
const GRACE_MS = 60_000;
export class Watchdog {
  private missingSince = new Map<string, number>();
  constructor(private db: Database, private log: EventLog, private runner: AgentRunner, private tasks: TaskService, private permits: PermitPool, private foreign?: ForeignSessions) {}
  async tick() {
    let rows: AgentRow[]; try { rows = await this.runner.list(true); } catch (e) { slog.warn("watchdog: agents --json failed — skipping tick", { e: String(e) }); return; }   // never treat an unknown roster as "everything died"
    const t = now();
    const tasks = this.db.query("select * from tasks where parent_uuid is null and process_state in ('starting','alive')").all().map(rowToTask);
    for (const task of tasks) {
      const row = rows.find((r) => (task.session_id && r.session_id === task.session_id) || (task.short_id && r.short_id === task.short_id));
      if (row?.alive) {
        this.missingSince.delete(task.uuid);
        // `claude --bg --resume` forks: the short id we spawned stays, the session id changes (phase 0 `resumeForksSessionId`).
        // Follow the fork chain instead of declaring the task lost — but never steal a session id another task already owns.
        if (row.session_id && row.session_id !== task.session_id && !this.db.query("select 1 from tasks where session_id=? and uuid<>?").get(row.session_id, task.uuid))
          this.log.emit({ type: "task.patched", task_uuid: task.uuid, payload: { patch: { session_id: row.session_id }, reason: "fork chain" } });
        if (task.process_state === "starting" && t - task.updated_at > GRACE_MS) this.log.emit({ type: "process.started", task_uuid: task.uuid, payload: { generation: task.process_generation + 1, session_id: row.session_id, short_id: row.short_id, pid: row.pid, source: "watchdog", patch: task.status === "starting" ? { status: "running", started_at: task.started_at ?? t } : {} } });
        if (row.waiting_for && task.last_step !== `waiting: ${row.waiting_for}`) this.log.emit({ type: "task.patched", task_uuid: task.uuid, payload: { patch: { last_step: `waiting: ${row.waiting_for}` } } });
        continue;
      }
      const since = this.missingSince.get(task.uuid) ?? t; this.missingSince.set(task.uuid, since);
      if (t - since < GRACE_MS) continue;
      this.missingSince.delete(task.uuid);
      const wasRunning = ["starting", "running"].includes(task.status) && !task.paused;
      this.log.emit({ type: "process.ended", task_uuid: task.uuid, payload: { reason: "watchdog: process gone", crashed: wasRunning } });
      if (wasRunning) { this.log.emit({ type: "task.status_changed", task_uuid: task.uuid, payload: { status: "error", patch: { status: "error", ended_at: t } } }); this.permits.releaseTask(task.uuid, "crashed"); this.log.emit({ type: "message.received", task_uuid: task.uuid, payload: chatFor("error", loadTask(this.db, task.uuid)!, "Session ended (no SessionEnd) — use Restart to --resume") }); }
    }
    for (const task of this.db.query("select * from tasks where attach_state<>'none'").all().map(rowToTask)) {
      const pid = Number(task.attached_by?.match(/^cli:(\d+)$/)?.[1] ?? 0);
      const gone = pid > 0 && !(() => { try { process.kill(pid, 0); return true; } catch { return false; } })();   // `relay attach` died (kill -9) without releasing
      if (gone || (task.attach_state === "leased" && t - task.updated_at > 5 * 60_000)) this.tasks.releaseAttach(task.uuid);
    }
    // Last, so ownership is read after this tick's fork-chain adoptions: everything left on the roster that relay does
    // not own is a session someone else started. Observation only — this writes no event and touches no task.
    try { this.foreign?.refresh(rows, t); } catch (e) { slog.warn("watchdog: foreign session refresh failed", { e: String(e) }); }
  }
}
