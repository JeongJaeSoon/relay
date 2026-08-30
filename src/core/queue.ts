import type { Database } from "bun:sqlite";
import type { Task } from "@shared/types.ts";
import { now } from "./clock.ts";
import { EventLog, loadTask, rowToTask } from "./events.ts";
import type { PermitPool } from "./permits.ts";
import { log as slog } from "../log.ts";

export class Scheduler {
  private pumping = false; private again = false;
  constructor(private db: Database, private log: EventLog, private permits: PermitPool, private onSlot: (t: Task) => Promise<void>, private isPaused: () => boolean) {}
  enqueue(taskUuid: string, qhead = false) { this.log.emit({ type: "task.status_changed", task_uuid: taskUuid, payload: { status: "queued", patch: { status: "queued", queued_at: now(), qhead, ended_at: null } } }); }
  async pump(): Promise<void> {
    if (this.pumping) { this.again = true; return; } this.pumping = true;
    try {
      do {
        this.again = false;
        if (this.isPaused()) break;
        const queued = this.db.query("select * from tasks where status='queued' and parent_uuid is null order by qhead desc, queued_at asc").all().map(rowToTask);
        for (const snap of queued) {
          const t = loadTask(this.db, snap.uuid); if (!t || t.status !== "queued") continue;      // changed while we awaited an earlier onSlot (e.g. interrupted)
          const proj = this.db.query("select is_git from projects where id=?").get(t.project_id) as any;
          // non-git projects run one session at a time: a task whose process is alive (even waiting_input) still occupies the project directory
          if (proj && !proj.is_git && this.db.query("select 1 from tasks where project_id=? and parent_uuid is null and uuid<>? and (status in ('starting','running') or process_state='alive')").get(t.project_id, t.uuid)) continue;
          if (!this.permits.acquire({ holder_kind: "task", holder_id: `task:${t.uuid}`, task_uuid: t.uuid, reason: "slot" })) break;
          this.log.emit({ type: "task.status_changed", task_uuid: t.uuid, payload: { status: "starting", patch: { status: "starting", qhead: false, started_at: t.started_at ?? now() } } });
          try { await this.onSlot(loadTask(this.db, t.uuid)!); }
          catch (e) { slog.error("onSlot failed — returning the slot", { task: t.uuid, e: String(e) }); this.permits.release(`task:${t.uuid}`, "onSlot failed"); this.enqueue(t.uuid, true); }
        }
      } while (this.again);
    } finally { this.pumping = false; }
  }
}
