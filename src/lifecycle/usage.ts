// src/lifecycle/usage.ts — usage sampling and the guards that ride on it (§5.4 / §11).
import type { Database } from "bun:sqlite";
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import type { Task } from "@shared/types.ts";
import type { Config } from "../config.ts";
import { now } from "../core/clock.ts";
import { EventLog } from "../core/events.ts";
import { ulid } from "../core/ids.ts";
import type { TaskService } from "../core/tasks.ts";
import type { PermitPool } from "../core/permits.ts";
import { getMeta, setMeta } from "../db/db.ts";
export class UsageGuard {
  private toolCalls = new Map<string, number>();
  constructor(private db: Database, private log: EventLog, private cfg: Config, private tasks: TaskService, private permits?: PermitPool) {}
  /** Sum message.usage of assistant lines appended since the last sample. Offsets persist per session (restart-safe); a shrunk file restarts from 0. Estimate only (§5.4). */
  sampleTranscript(task: Task, path: string): number {
    if (!existsSync(path)) return 0;
    const key = `usage_offset:${task.session_id ?? task.uuid}`;
    const size = statSync(path).size; let from = Number(getMeta(this.db, key) ?? 0); if (size < from) from = 0; if (size <= from) return 0;
    const fd = openSync(path, "r"); const buf = Buffer.alloc(size - from); readSync(fd, buf, 0, buf.length, from); closeSync(fd);
    const text = buf.toString("utf8"); const lastNl = text.lastIndexOf("\n"); const complete = lastNl >= 0 ? text.slice(0, lastNl + 1) : "";
    setMeta(this.db, key, String(from + Buffer.byteLength(complete)));
    let delta = 0;
    for (const line of complete.split("\n")) { if (!line) continue; try { const j = JSON.parse(line); const u = j.message?.usage; if (j.type === "assistant" && u) delta += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0); } catch {} }
    if (delta) this.log.emit({ type: "usage.sampled", task_uuid: task.uuid, payload: { source: "worker", delta } });
    return delta;
  }
  countToolCall(taskUuid: string, promptId: string | null): boolean {   // returns true when the per-turn cap is exceeded
    const key = `${taskUuid}:${promptId ?? "?"}`; const n = (this.toolCalls.get(key) ?? 0) + 1; this.toolCalls.set(key, n); return n > this.cfg.usage.max_tool_calls_per_turn;
  }
  tick() {
    const t = now();
    // subagent leases older than their task's wall-clock cap are stuck (SubagentStop never came) → reclaim (B5 ②)
    for (const l of this.db.query("select l.holder_id, t.size, l.acquired_at from permit_leases l join tasks t on t.uuid=l.task_uuid where l.holder_kind='subagent' and l.released_at is null").all() as any[])
      if (t - l.acquired_at > this.cfg.usage.wall_clock_min[l.size as "small" | "normal" | "epic"] * 60_000) this.permits?.release(l.holder_id, "subagent wall-clock");
    for (const r of this.db.query("select uuid, size, started_at, display_id, title from tasks where parent_uuid is null and status in ('starting','running') and started_at is not null").all() as any[]) {
      if (t - r.started_at > this.cfg.usage.wall_clock_min[r.size as "small" | "normal" | "epic"] * 60_000) { this.tasks.interrupt(r.uuid); this.system(`⏱ ${r.display_id} ${r.title} — wall-clock 상한 초과로 중단됨`); }
    }
    const ceiling = this.cfg.usage.daily_ceiling_tokens;
    if (ceiling != null && !this.tasks.paused()) {
      const dayStart = new Date(t); dayStart.setHours(0, 0, 0, 0);
      const today = (this.db.query("select coalesce(sum(json_extract(payload_json,'$.delta')),0) c from events where type='usage.sampled' and occurred_at>=?").get(dayStart.getTime()) as any).c;
      if (today >= ceiling) { this.tasks.pause(); this.system(`⛔ 일일 사용량 상한(${ceiling} tok) 도달 — kill switch ON. 내일 또는 수동 재개.`); }
    }
  }
  private system(text: string) { this.log.emit({ type: "message.received", payload: { id: ulid(), role: "system", source: "user", client_message_id: null, dispatch_state: "direct", text, task_uuid: null, reply_to_task_uuid: null, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: now() } }); }
}
