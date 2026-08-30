// src/lifecycle/outbox.ts — commands table + per-task serial executor (roadmap B3).
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandKind, DeliveryMethod, SendOutcome, Task } from "@shared/types.ts";
import { now } from "../core/clock.ts";
import { EventLog, loadTask, type EmitInput } from "../core/events.ts";
import { commandId } from "../core/ids.ts";
import type { AgentRow, AgentRunner, SpawnSpec } from "../runner/runner.ts";
import { log as slog } from "../log.ts";

export type CommandPayload =
  | { kind: "spawn"; spec: SpawnSpec }
  | { kind: "send"; text: string; marker: string; message_id?: string }
  | { kind: "stop"; reason: string }
  | { kind: "resume"; prompt: string; marker: string }
  | { kind: "rm" };
export interface OutboxDeps { delivery: () => DeliveryMethod; isPaused: () => boolean; settingsJson: (t: Task) => string; env: (t: Task, gen: number) => Record<string, string>; socketPathFor: (row: AgentRow) => string; instanceId: () => string }
/** Thrown by apply() when the command must stay pending and the task queue must stop for now (inbox held, turn busy). */
class HeldError extends Error {}
const rowToCommand = (r: any): Command => ({ ...r, payload: JSON.parse(r.payload_json) });
export const OWNER_FILE = ".relay-owner";
export interface Owner { relay_instance_id: string; task_uuid: string; session_id: string | null }
export function readOwner(cwd: string | null): Owner | null { try { return cwd ? JSON.parse(readFileSync(join(cwd, OWNER_FILE), "utf8")) : null; } catch { return null; } }

export class Outbox {
  private inflight = new Map<string, Promise<void>>(); private again = new Set<string>();
  constructor(private db: Database, private log: EventLog, private runner: AgentRunner, private deps: OutboxDeps) {}
  /** The `command.queued` emit input for (kind, taskUuid, key) — lets TaskService commit a decision, its task and its first command in ONE transaction (A9). */
  commandInput(taskUuid: string, key: string, payload: CommandPayload): { id: string; input: EmitInput } {
    const id = commandId(payload.kind, `${taskUuid}:${key}`);
    return { id, input: { type: "command.queued", task_uuid: taskUuid, causation_id: id, payload: { id, kind: payload.kind, payload } } };
  }
  /** Idempotent by (kind, taskUuid, key). Execution order is insertion order (rowid), never the hash id. */
  enqueue(taskUuid: string, key: string, payload: CommandPayload): Command {
    const { id, input } = this.commandInput(taskUuid, key, payload); this.log.emit(input); this.kick(taskUuid);
    return rowToCommand(this.db.query("select * from commands where id=?").get(id));
  }
  kick(taskUuid: string) { queueMicrotask(() => this.run(taskUuid).catch((e) => slog.error("outbox run failed", { taskUuid, e: String(e) }))); }
  async runAll() { for (const r of this.db.query("select distinct task_uuid from commands where state='pending'").all() as any[]) await this.run(r.task_uuid); }
  confirm(id: string) { const c = rowToCommand(this.db.query("select * from commands where id=?").get(id)); this.log.emit({ type: "command.applied", task_uuid: c.task_uuid, payload: { id } }); this.kick(c.task_uuid); }
  retry(id: string) { const c = rowToCommand(this.db.query("select * from commands where id=?").get(id)); this.log.emit({ type: "command.requeued", task_uuid: c.task_uuid, payload: { id } }); this.kick(c.task_uuid); }
  /** Drop pending commands that no longer make sense (interrupt/close). Keeps I5: closed ⇒ no pending commands. */
  cancelPending(taskUuid: string, kinds: CommandKind[], reason: string) {
    for (const r of this.db.query("select id, kind from commands where task_uuid=? and state in ('pending','unknown')").all(taskUuid) as any[])
      if (kinds.includes(r.kind)) this.log.emit({ type: "command.failed", task_uuid: taskUuid, causation_id: r.id, payload: { id: r.id, error: `cancelled: ${reason}` } });
  }
  /** Startup (B3 crash points): a command left `running` by a crash. spawn → pending (apply() adopts an already-running session by owner file); others → unknown (user confirms/retries; a marker echo still promotes send/resume). */
  reconcileRunning(): { requeued: string[]; unknown: string[] } {
    const out = { requeued: [] as string[], unknown: [] as string[] };
    for (const r of this.db.query("select id, task_uuid, kind from commands where state='running' order by rowid").all() as any[]) {
      if (r.kind === "spawn") { this.log.emit({ type: "command.requeued", task_uuid: r.task_uuid, payload: { id: r.id } }); out.requeued.push(r.id); }
      else { this.log.emit({ type: "command.unknown", task_uuid: r.task_uuid, causation_id: r.id, payload: { id: r.id, error: "relay restarted during execution" } }); out.unknown.push(r.id); }
    }
    return out;
  }
  markAccepted(taskUuid: string, marker: string) {
    for (const r of this.db.query("select * from commands where task_uuid=? and state in ('unknown','running','pending') and kind in ('send','resume') order by rowid").all(taskUuid) as any[]) {
      const c = rowToCommand(r); if ((c.payload as any).marker === marker) { this.log.emit({ type: "command.applied", task_uuid: taskUuid, causation_id: c.id, payload: { id: c.id } }); this.log.emit({ type: "send.outcome", task_uuid: taskUuid, causation_id: c.id, payload: { command_id: c.id, outcome: "accepted", via: "marker", message_id: (c.payload as any).message_id ?? null } }); }
    }
  }
  /** Drains the task's queue head-first (a pending stop/rm is always the head). Stops on: empty queue (re-run if enqueue raced us), a blocked/held head (an external trigger — Stop hook, attach release, retry — re-runs), or an unknown/failed head. Awaiting run() awaits the in-flight pass too (recovery relies on that). */
  run(taskUuid: string): Promise<void> {
    const cur = this.inflight.get(taskUuid); if (cur) { this.again.add(taskUuid); return cur; }
    const p = this.loop(taskUuid).then((stop) => { this.inflight.delete(taskUuid); const again = this.again.delete(taskUuid); if (stop === "empty" && again) return this.run(taskUuid); }, (e) => { this.inflight.delete(taskUuid); this.again.delete(taskUuid); throw e; });
    this.inflight.set(taskUuid, p); return p;
  }
  private async loop(taskUuid: string): Promise<"empty" | "blocked" | "held" | "error"> {
    for (;;) {
      this.again.delete(taskUuid);
      const row = this.db.query("select * from commands where task_uuid=? and state in ('pending','unknown') order by (case when kind in ('stop','rm') and state='pending' then 0 else 1 end), rowid limit 1").get(taskUuid) as any;   // stop/rm jump the queue
      if (!row) return "empty";
      if (row.state === "unknown") return "blocked";                          // I8: an unknown head blocks the queue until the user confirms/retries
      const cmd = rowToCommand(row); const task = loadTask(this.db, taskUuid)!;
      if (!this.canRun(cmd, task)) return "blocked";                          // stays pending (I3, B1)
      this.log.emit({ type: "command.running", task_uuid: taskUuid, causation_id: cmd.id, payload: { id: cmd.id } });
      try { await this.apply(cmd, task); }
      catch (e) {
        if (e instanceof HeldError) { this.log.emit({ type: "command.requeued", task_uuid: taskUuid, payload: { id: cmd.id } }); return "held"; }
        this.log.emit({ type: "command.unknown", task_uuid: taskUuid, causation_id: cmd.id, payload: { id: cmd.id, error: String(e).slice(0, 300) } });   // B3: retries are manual (confirm/retry)
        slog.warn("command failed", { id: cmd.id, e: String(e) }); return "error";
      }
    }
  }
  /** B1 gate. A slot is only ever granted by the scheduler (status=starting), so spawn/resume never run for a merely `queued` task. `stop`/`rm` always run (kill switch and close win over attach; the API refuses user-initiated interrupt/close while attached). */
  private canRun(cmd: Command, t: Task): boolean {
    const k = cmd.kind;
    if (k === "stop" || k === "rm") return true;
    if (t.attach_state !== "none") return false;
    if (this.deps.isPaused()) return false;
    if (k === "spawn" && t.status !== "starting") return false;
    if (k === "resume" && !(t.status === "starting" || t.paused)) return false;
    if (k === "send" && !["starting", "running", "waiting_input"].includes(t.status)) return false;
    // turn-boundary delivery (B1/C12): the resume path must not cut a running turn; TaskService.onStop re-runs the queue
    if ((k === "send" || k === "resume") && this.deps.delivery() !== "socket" && t.process_state === "alive" && t.turn_state === "busy" && !t.paused) return false;
    return true;
  }
  private applied(cmd: Command, t: Task, extra: Record<string, unknown> = {}) { this.log.emit({ type: "command.applied", task_uuid: t.uuid, causation_id: cmd.id, payload: { id: cmd.id, ...extra } }); }
  private patch(t: Task, patch: Record<string, unknown>, cmd: Command) { this.log.emit({ type: "task.patched", task_uuid: t.uuid, causation_id: cmd.id, payload: { patch } }); }
  private async waitGone(shortId: string, ms = 10_000) { const t0 = now(); while (now() - t0 < ms) { const r = (await this.runner.list()).find((x) => x.short_id === shortId); if (!r || !r.alive) return true; await Bun.sleep(300); } return false; }
  private async waitRow(shortId: string, ms = 10_000): Promise<AgentRow | undefined> { const t0 = now(); for (;;) { const r = (await this.runner.list(true)).find((x) => x.short_id === shortId); if (r?.cwd && r.session_id) return r; if (now() - t0 > ms) return r; await Bun.sleep(300); } }
  /** Ownership stamp + base_sha, written right after spawn (roadmap B8/§6.3). Adoption and reconcile require it to match. */
  private stampWorktree(t: Task, row: AgentRow) {
    const owner: Owner = { relay_instance_id: this.deps.instanceId(), task_uuid: t.uuid, session_id: row.session_id };
    let base_sha: string | null = null, branch: string | null = null;
    try { if (row.cwd && existsSync(row.cwd)) { writeFileSync(join(row.cwd, OWNER_FILE), JSON.stringify(owner)); const g = (a: string[]) => { const p = Bun.spawnSync(["git", "-C", row.cwd!, ...a], { stdout: "pipe", stderr: "ignore" }); return p.exitCode === 0 ? p.stdout.toString().trim() : null; }; base_sha = g(["rev-parse", "HEAD"]); branch = g(["rev-parse", "--abbrev-ref", "HEAD"]); } } catch (e) { slog.warn("owner stamp failed", { e: String(e) }); }
    return { worktree_path: row.cwd, session_id: row.session_id, base_sha, branch };
  }
  private async apply(cmd: Command, t: Task) {
    const p = cmd.payload as CommandPayload;
    switch (p.kind) {
      case "spawn": {
        const gen = t.process_generation + 1;
        // adopt only a session that is provably ours: same name AND our owner stamp in its cwd (a crash between exec and record)
        const existing = (await this.runner.list()).find((r) => r.name === p.spec.name && r.alive && readOwner(r.cwd)?.task_uuid === t.uuid);
        const res = existing ? { short_id: existing.short_id!, name: existing.name! } : await this.runner.spawn({ ...p.spec, settingsJson: this.deps.settingsJson(t), env: this.deps.env(t, gen) });
        const row = existing ?? (await this.waitRow(res.short_id));
        this.patch(t, { short_id: res.short_id, process_state: "starting", ...(row ? this.stampWorktree(t, row) : {}) }, cmd);
        this.applied(cmd, t, { short_id: res.short_id, adopted: !!existing }); return;
      }
      case "send": case "resume": {
        const text = p.kind === "send" ? `[relay #${p.marker}] ${p.text}` : `[relay #${p.marker}] ${p.prompt}`;
        const messageId = p.kind === "send" ? p.message_id ?? null : null;
        const outcome = (o: SendOutcome, via: string) => this.log.emit({ type: "send.outcome", task_uuid: t.uuid, causation_id: cmd.id, payload: { command_id: cmd.id, outcome: o, via, message_id: messageId } });
        const live = t.short_id || t.session_id ? (await this.runner.list()).find((r) => (t.short_id && r.short_id === t.short_id) || (t.session_id && r.session_id === t.session_id)) : undefined;
        // `agents --json` has no pid for background rows, so liveness alone gates the socket path; socketPathFor resolves
        // the inbox socket from the session registry (roadmap C3), not from this row's pid.
        if (p.kind === "send" && this.deps.delivery() === "socket" && live?.alive && this.runner.sendSocket) {
          const o: SendOutcome = await this.runner.sendSocket(this.deps.socketPathFor(live), text, cmd.id);
          outcome(o, "socket");
          if (o === "accepted") { this.applied(cmd, t); return; }
          if (o === "refused") { this.log.emit({ type: "command.failed", task_uuid: t.uuid, causation_id: cmd.id, payload: { id: cmd.id, error: "refused by inbox" } }); return; }
          if (o === "unknown") { this.log.emit({ type: "command.unknown", task_uuid: t.uuid, causation_id: cmd.id, payload: { id: cmd.id, error: "no status frame" } }); return; }
          throw new HeldError("inbox held the message");                       // stays pending; retried on the next run() trigger (Stop hook, retry, timer)
        }
        if (!t.session_id) throw new Error("no session_id to resume");
        if (live?.alive && live.short_id) { await this.runner.stop(live.short_id); if (!(await this.waitGone(live.short_id))) throw new Error("stop not confirmed"); }
        const gen = t.process_generation + 1;
        const r = await this.runner.resume({ sessionId: t.session_id, cwd: live?.cwd ?? t.worktree_path ?? process.cwd(), name: `relay:${t.display_id} ${t.title}`, settingsJson: this.deps.settingsJson(t), prompt: text, env: this.deps.env(t, gen) });
        this.patch(t, { short_id: r.short_id, process_state: "starting", paused: false }, cmd);
        outcome("accepted", "resume");                                       // B3: applied at `backgrounded ·` parse time; SessionStart(gen) confirms, watchdog fills a gap
        this.applied(cmd, t, { short_id: r.short_id }); return;
      }
      case "stop": {
        if (t.short_id) { await this.runner.stop(t.short_id); if (!(await this.waitGone(t.short_id))) throw new Error("stop not confirmed"); }
        if (t.process_state === "alive" || t.process_state === "starting") this.log.emit({ type: "process.ended", task_uuid: t.uuid, causation_id: cmd.id, payload: { reason: p.reason, crashed: false } });
        this.applied(cmd, t); return;
      }
      case "rm": {
        const r = t.short_id ? await this.runner.rm(t.short_id) : { worktreeKept: false };
        this.patch(t, { process_state: "stopped" }, cmd); this.applied(cmd, t, { worktreeKept: r.worktreeKept }); return;
      }
    }
  }
}
