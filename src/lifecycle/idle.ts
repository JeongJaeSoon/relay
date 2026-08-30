// src/lifecycle/idle.ts — idle deadlines (§5.4): stop an idle-but-alive session, close a long-finished task.
import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import { now } from "../core/clock.ts";
import { EventLog } from "../core/events.ts";
import type { TaskService } from "../core/tasks.ts";
import type { Outbox } from "./outbox.ts";
export class IdleReaper {
  constructor(private db: Database, private log: EventLog, private cfg: Config, private outbox: Outbox, private tasks: TaskService) {}
  tick() {
    const t = now(); const stopBefore = t - this.cfg.idle.stop_after_min * 60_000; const closeBefore = t - this.cfg.idle.close_after_hours * 3600_000;
    for (const r of this.db.query("select uuid from tasks where parent_uuid is null and status in ('done','waiting_input','needs_review','cancelled') and process_state='alive' and attach_state='none' and updated_at<? and not exists (select 1 from commands c where c.task_uuid=tasks.uuid and c.kind='stop' and c.state in ('pending','running'))").all(stopBefore) as any[]) {
      this.log.emit({ type: "idle.deadline", task_uuid: r.uuid, payload: { action: "stop", patch: {} } });
      this.outbox.enqueue(r.uuid, `idle:${t}`, { kind: "stop", reason: "idle" });
    }
    for (const r of this.db.query("select uuid from tasks where parent_uuid is null and status in ('done','cancelled') and updated_at<?").all(closeBefore) as any[]) {
      this.log.emit({ type: "idle.deadline", task_uuid: r.uuid, payload: { action: "close", patch: {} } }); this.tasks.close(r.uuid);
    }
  }
}
