// src/lifecycle/idle.ts — idle deadlines (§5.4): stop an idle-but-alive session, close a long-finished task.
import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import { now } from "../core/clock.ts";
import { EventLog } from "../core/events.ts";
import type { TaskService } from "../core/tasks.ts";
import type { Outbox } from "./outbox.ts";
export class IdleReaper {
  constructor(private db: Database, private log: EventLog, private cfg: Config, private outbox: Outbox, _tasks: TaskService) {}
  tick() {
    const t = now(); const stopBefore = t - this.cfg.idle.stop_after_min * 60_000;
    // `error` belongs here too: recovery restores a live roster session to `alive` but only rewrites the status when it
    // was `starting` (recovery.ts §①), so an errored task whose session came back — the daemon respawn after a kill -9 —
    // stayed alive and idle until the 72h deadline. A stop costs `retry` nothing: it resumes from `session_id`, which is
    // the same "use Restart to --resume" path `onCrash` already offers, and the resume path stops a live session anyway.
    for (const r of this.db.query("select uuid from tasks where parent_uuid is null and status in ('done','waiting_input','needs_review','cancelled','error') and process_state='alive' and attach_state='none' and updated_at<? and not exists (select 1 from commands c where c.task_uuid=tasks.uuid and c.kind='stop' and c.state in ('pending','running'))").all(stopBefore) as any[]) {
      this.log.emit({ type: "idle.deadline", task_uuid: r.uuid, payload: { action: "stop", patch: {} } });
      this.outbox.enqueue(r.uuid, `idle:${t}`, { kind: "stop", reason: "idle" });
    }
    // `[idle].close_after_hours` is goal-lifecycle policy for calculating `review_due`; it is never authority to close
    // a task or remove its worktree. Goal review/archival and an explicitly chosen cleanup action own those transitions.
    // A disposal held on a locked worktree waits for a run() that a closing task gets from nowhere else. This timer is
    // that trigger. A REAP rm is held the same way, so this must not filter on `target` — retryable was added at both
    // rm sites and the retry has to reach both. The hold itself is bounded (`LOCK_HOLD_MS`); a lock that never clears
    // becomes an ordinary refusal rather than a command pending for ever.
    for (const r of this.db.query("select distinct task_uuid uuid from commands where kind='rm' and state='pending'").all() as any[]) this.outbox.kick(r.uuid);
  }
}
