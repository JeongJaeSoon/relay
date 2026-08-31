// src/core/tasks.ts — orchestration around tasks: decisions → tasks/commands, verdicts → statuses, user actions.
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { DispatchDecision, DispatchItem, Message, Task, TaskQuestion, TaskSize } from "@shared/types.ts";
import type { Config } from "../config.ts";
import { now } from "./clock.ts";
import { EventLog, loadMessage, loadTask, type EmitInput } from "./events.ts";
import { displayId, short8, taskUuid as newUuid, ulid } from "./ids.ts";
import type { PermitPool } from "./permits.ts";
import type { Scheduler } from "./queue.ts";
import { chatFor, type MessageInput } from "./promote.ts";
import { verdict } from "./verdict.ts";
import type { Outbox } from "../lifecycle/outbox.ts";
import { cancelPermissions, type IngestDeps, type PendingPermission } from "../hooks/ingest.ts";
import type { Dispatcher } from "../dispatcher/dispatcher.ts";
import { getMeta } from "../db/db.ts";
import { splitGuard } from "../dispatcher/schema.ts";

interface Deps { db: Database; log: EventLog; cfg: Config; permits: PermitPool; scheduler: Scheduler; outbox: Outbox; projectNameOf: (id: string) => string; pendingPermissions: Map<string, PendingPermission> }
/** 8 hex chars embedded as `[relay #xxxxxxxx]`; the worker echoes it back through UserPromptSubmit so relay can confirm delivery. */
const marker = () => randomBytes(4).toString("hex");
const markerFor = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 8);
/** One item of a decision, planned but not yet emitted: `created` must be emitted before `rest` (task rows are a FK for the chat rows and commands that follow). */
type TaskPlan = { uuid: string; display_id: string; project_id: string; created: EmitInput[]; rest: EmitInput[]; kick: boolean };
const sysMsg = (text: string, taskUuid: string | null = null): MessageInput => ({ id: ulid(), role: "system", source: "user", client_message_id: null, dispatch_state: "direct", text, task_uuid: taskUuid, reply_to_task_uuid: null, ask: false, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: now() });

export class TaskService {
  ingestDeps: IngestDeps;
  onNudge: (t: Task) => void = () => {};                                     // wired to Watchdog.tick by serve()
  onToolUse: (t: Task, promptId: string | null) => void = () => {};          // wired to UsageGuard by serve()
  constructor(private d: Deps) {
    this.ingestDeps = { db: d.db, log: d.log, permits: d.permits, policy: { decide: () => "ask" }, onStop: (t, b) => this.onStop(t, b), onCrash: (t, r) => this.onCrash(t, r), onQuestion: (t, q) => this.chat(chatFor("question", t, `${q.text} (${q.options.join(" / ")})`)),
      onToolUse: (t, p) => this.onToolUse(t, p), onNudge: (t) => this.onNudge(t), onRateLimit: (t, text) => this.onRateLimit(t, text), onSendMarker: (u, m) => d.outbox.markAccepted(u, m), permissions: d.pendingPermissions };
  }
  paused() { return getMeta(this.d.db, "kill_switch") === "1"; }
  private byDisplay(id: string): Task | null { const r = this.d.db.query("select uuid from tasks where display_id=? and parent_uuid is null and status!='closed' order by num desc limit 1").get(id) as any; return r ? loadTask(this.d.db, r.uuid) : null; }
  private chat(m: MessageInput) { this.d.log.emit({ type: "message.received", task_uuid: m.task_uuid, payload: m }); }
  private status(t: Task | string, status: Task["status"], patch: Record<string, unknown> = {}) { const uuid = typeof t === "string" ? t : t.uuid; this.d.log.emit({ type: "task.status_changed", task_uuid: uuid, payload: { status, patch: { status, ...patch } } }); }
  private spec(t: Task, prompt: string) {
    const proj = this.d.db.query("select path, is_git from projects where id=?").get(t.project_id) as any;
    return { taskUuid: t.uuid, displayId: t.display_id, name: `relay:${t.display_id} ${t.title}`, cwd: proj.path, worktree: proj.is_git ? `relay-${short8(t.uuid)}` : null, model: t.model, effort: t.effort, permissionMode: this.d.cfg.worker.permission_mode,
      advisor: this.d.cfg.worker.advisor && this.d.cfg.worker.advisor_for.includes(t.size) ? this.d.cfg.worker.advisor : null, agent: "relay-worker", settingsJson: "{}", prompt, env: {} };
  }

  // ---- decisions (A9: the decision record, the task and its first command are committed in ONE transaction) ---------------
  applyDecision(msg: Message, dec: DispatchDecision, dispatchPatch: Partial<Message> = {}) {
    const done = (extra: Partial<Message> = {}): EmitInput => ({ type: "dispatch.completed", payload: { message_id: msg.id, patch: { dispatch_state: "dispatched", dispatch_json: dec, ...dispatchPatch, ...extra } } });
    const badge = sysMsg(`dispatcher · ${dec.action}${dec.size ? " · " + dec.size : ""}${dec.project ? " · " + dec.project : ""}${dec.task_id ? " · " + dec.task_id : ""}`);
    const badgeIn: EmitInput = { type: "message.received", payload: badge };
    switch (dec.action) {
      case "new_task": {
        const p = this.planNewTask(msg, dec, msg.id, 0);
        if ("error" in p) return this.needsConfirm(msg, dec, p.error);
        this.d.log.emitMany([...p.created, done({ task_uuid: p.uuid }), badgeIn, ...p.rest]);   // task row first (FK), then the message patch, badge, started chat, spawn
        void this.d.scheduler.pump(); return;
      }
      case "route_to_task": {
        const t = this.byDisplay(dec.task_id!); if (!t) return this.needsConfirm(msg, dec, `task ${dec.task_id} not found`);
        if (t.status === "error") { this.d.log.emitMany([done({ task_uuid: t.uuid }), badgeIn]); return this.needsConfirm(msg, null, `${t.display_id} is in the error state — restart it first`); }
        if (t.status === "waiting_input" && t.question?.source === "permission") { this.d.log.emitMany([done({ task_uuid: t.uuid }), badgeIn]); this.answer(t.uuid, dec.prompt ?? msg.text, null); return; }
        const p = this.planRoute(msg, dec, t, msg.id);
        this.d.log.emitMany([done({ task_uuid: t.uuid }), badgeIn, ...p.rest]); this.d.outbox.kick(t.uuid); void this.d.scheduler.pump(); return;
      }
      case "answer_directly": { this.d.log.emitMany([done(), badgeIn, { type: "message.received", payload: { ...sysMsg(dec.answer ?? ""), role: "dispatcher_answer" } }]); return; }
      case "close_task": { const t = this.byDisplay(dec.task_id!); if (!t) return this.needsConfirm(msg, dec, `task ${dec.task_id} not found`); this.d.log.emitMany([done({ task_uuid: t.uuid }), badgeIn, { type: "message.received", task_uuid: t.uuid, payload: sysMsg(`Close ${t.display_id} ${t.title}? [close confirm: POST /api/tasks/${t.uuid}/close]`, t.uuid) }]); return; }
      case "split": return this.applySplit(msg, dec, done);
    }
  }

  /** Design C: one message becomes several tasks. Every guardrail is checked and every item is planned BEFORE the
   *  first emit, so a split either lands whole through one emitMany or never starts — half of it dispatched with the
   *  rest silently dropped is the worst outcome available (C.4.2, C.4.3). */
  private applySplit(msg: Message, dec: DispatchDecision, done: (extra?: Partial<Message>) => EmitInput) {
    const refused = splitGuard(dec, this.d.cfg.dispatcher.max_split);
    if (refused) return this.needsConfirm(msg, dec, refused);
    const plans: TaskPlan[] = []; let newTasks = 0; let plan: TaskPlan;
    for (const [i, it] of dec.items!.entries()) {
      const at = `split item ${i + 1}`; const key = `${msg.id}:${i}`;
      if (it.action === "new_task") {
        const p = this.planNewTask(msg, it, key, newTasks);
        if ("error" in p) return this.needsConfirm(msg, dec, `${at}: ${p.error}`);
        plan = p; newTasks++;
      } else {
        const t = this.byDisplay(it.task_id!);
        if (!t) return this.needsConfirm(msg, dec, `${at}: task ${it.task_id} not found`);
        if (t.status === "error") return this.needsConfirm(msg, dec, `${at}: ${t.display_id} is in the error state — restart it first`);
        if (t.status === "waiting_input" && t.question?.source === "permission") return this.needsConfirm(msg, dec, `${at}: ${t.display_id} is waiting on a permission answer — answer it first`);
        plan = this.planRoute(msg, it, t, key);
      }
      // C.2, and the only guard that holds when the model is wrong: two worktrees on one repository can edit
      // overlapping files, leaving a merge for a human. "Ships separately" and "different lifetimes" both read as
      // splittable for same-repo work, so the criterion enforced here is the structural one — one project per split.
      const j = plans.findIndex((p) => p.project_id === plan.project_id);
      if (j >= 0) {
        const other = plans[j].created.length ? `split item ${j + 1}` : plans[j].display_id;   // a task this split only planned has no id the user can see; a route target already does
        return this.needsConfirm(msg, dec, `${at}: same project (${this.d.projectNameOf(plan.project_id)}) as ${other} — work sharing one repository stays a single task`);
      }
      plans.push(plan);
    }
    const ids = plans.map((p) => p.display_id);
    this.d.log.emitMany([
      ...plans.flatMap((p) => p.created),                                                   // task rows first: the message patch, the chat rows and the commands below all reference them
      done({ task_uuid: plans[0].uuid, dispatch_json: { ...dec, task_ids: ids } }),         // C.4.4: messages.task_uuid holds one value — the first — and dispatch_json carries the whole list
      { type: "message.received", payload: sysMsg(`dispatcher · split · ${plans.length} · ${ids.join(" ")}`) },
      ...plans.flatMap((p) => p.rest),
    ]);
    for (const p of plans) if (p.kick) this.d.outbox.kick(p.uuid);
    void this.d.scheduler.pump();
  }

  /** Plans a task without emitting. `key` makes the spawn command and its delivery marker unique per item; `numOffset`
   *  keeps `num` unique when a split allocates several task rows against one `max(num)` read. */
  private planNewTask(msg: Message, it: DispatchItem | DispatchDecision, key: string, numOffset: number): TaskPlan | { error: string } {
    const proj = this.d.db.query("select id from projects where name=? or id=?").get(it.project ?? "", it.project ?? "") as any;
    if (!proj) return { error: `project ${it.project} not registered` };
    const size: TaskSize = it.size ?? "normal"; const uuid = newUuid(); const num = (this.d.db.query("select coalesce(max(num),0)+1 n from tasks where parent_uuid is null").get() as any).n + numOffset; const t = now();
    const task: Task = { uuid, num, display_id: displayId(num), project_id: proj.id, title: it.title ?? msg.text.slice(0, 24), status: "queued", size, effort: this.d.cfg.worker.effort[size], model: this.d.cfg.worker.model,
      session_id: null, short_id: null, worktree_path: null, branch: null, base_sha: null, process_state: "none", process_generation: 0, turn_state: "idle", attach_state: "none", attached_by: null, paused: false,
      last_summary: null, last_step: null, question: null, parent_uuid: null, agent_id: null, agent_type: null, queued_at: t, qhead: false, started_at: null, ended_at: null, created_at: t, updated_at: t, closed_at: null, usage_tokens: 0, summary_json: null };
    const spawn = this.d.outbox.commandInput(uuid, key, { kind: "spawn", spec: this.spec(task, `[relay #${markerFor(key)}] ${task.display_id} · project=${this.d.projectNameOf(proj.id)} · size=${size}\n\n${it.prompt ?? msg.text}`) });
    return { uuid, display_id: task.display_id, project_id: proj.id, created: [{ type: "task.created", task_uuid: uuid, causation_id: msg.id, payload: task }],
      rest: [{ type: "message.received", task_uuid: uuid, payload: chatFor("started", task, "", this.d.projectNameOf(proj.id)) }, spawn.input], kick: false };
  }

  /** The plain follow-up path, shared by route_to_task and a split's route items. The caller has already ruled out the
   *  two diversions (error state, held permission question) that are not a plain send. */
  private planRoute(msg: Message, it: DispatchItem | DispatchDecision, t: Task, key: string): TaskPlan {
    const text = it.prompt ?? msg.text;
    const send = this.d.outbox.commandInput(t.uuid, key, { kind: "send", text, marker: marker(), message_id: msg.id });
    const rest: EmitInput[] = [];
    if (t.status === "waiting_input") rest.push({ type: "question.answered", task_uuid: t.uuid, causation_id: msg.id, payload: { text, patch: { question: null } } });
    rest.push(send.input);
    if (["done", "needs_review", "cancelled", "waiting_input"].includes(t.status)) rest.push({ type: "task.status_changed", task_uuid: t.uuid, payload: { status: "queued", patch: { status: "queued", queued_at: now(), qhead: true, ended_at: null } } });
    return { uuid: t.uuid, display_id: t.display_id, project_id: t.project_id, created: [], rest, kick: true };
  }
  needsConfirm(msg: Message, dec: DispatchDecision | null, reason: string) {
    const active = this.d.db.query("select display_id, title from tasks where parent_uuid is null and status not in ('closed') order by updated_at desc limit 6").all() as any[];
    const opts = active.map((t) => `${t.display_id} ${t.title}`).join(" / ");
    const inputs: EmitInput[] = [{ type: "message.received", payload: sysMsg(`Routing needs confirmation (${reason}${dec ? `, candidate: ${dec.action}${dec.task_id ? " " + dec.task_id : ""}` : ""}). Which task? ${opts || "(no active tasks — for a new one, name the project)"}`) }];
    // Only patch a message that exists: sendTo() calls this with a synthetic id for a follow-up that never was a chat row.
    const existing = loadMessage(this.d.db, msg.id);
    if (existing && existing.dispatch_state !== "needs_confirm") inputs.unshift({ type: "dispatch.completed", payload: { message_id: msg.id, patch: { dispatch_state: "needs_confirm", dispatch_json: dec } } });
    this.d.log.emitMany(inputs);
  }
  /** Scheduler granted a slot: spawn (never ran) or let the pending send/resume command run (ran before). */
  async startSlot(t: Task) { await this.d.outbox.run(t.uuid); }
  /** Three cases (B1): permission question → resolve the held hook (worker continues; no scheduler); marker question → queue at head and send; otherwise a plain follow-up. Returns false for a late/unknown permission answer (API → 409). */
  answer(taskUuid: string, text: string, viaMessageId: string | null): boolean {
    const t = loadTask(this.d.db, taskUuid)!;
    if (viaMessageId) this.d.log.emit({ type: "dispatch.completed", payload: { message_id: viaMessageId, patch: { task_uuid: taskUuid, dispatch_state: "direct" } } });
    if (t.status === "waiting_input" && t.question?.source === "permission" && t.question.permission_tool_use_id) {
      const key = `${t.session_id}:${t.question.permission_tool_use_id}`; const p = this.d.pendingPermissions.get(key);
      if (!p) { this.d.log.emit({ type: "question.answered", task_uuid: taskUuid, causation_id: viaMessageId, payload: { text, patch: { question: null }, late: true } }); this.status(t, "running"); return false; }   // auto-denied already (14 min) — nothing to resolve
      p.resolve(/^(허용|allow|yes|y)$/i.test(text.trim()) ? "allow" : "deny");
      this.d.log.emit({ type: "question.answered", task_uuid: taskUuid, causation_id: viaMessageId, payload: { text, patch: { question: null } } });
      this.status(t, "running", { turn_state: "busy" }); return true;
    }
    if (t.status === "waiting_input") {
      const send = this.d.outbox.commandInput(taskUuid, viaMessageId ?? ulid(), { kind: "send", text, marker: marker(), message_id: viaMessageId ?? undefined });
      this.d.log.emitMany([{ type: "question.answered", task_uuid: taskUuid, causation_id: viaMessageId, payload: { text, patch: { question: null } } }, send.input, { type: "task.status_changed", task_uuid: taskUuid, payload: { status: "queued", patch: { status: "queued", queued_at: now(), qhead: true, ended_at: null } } }]);
      this.d.outbox.kick(taskUuid); void this.d.scheduler.pump(); return true;
    }
    this.sendTo(t, text, viaMessageId ?? ulid()); return true;
  }
  private sendTo(t: Task, text: string, key: string) {
    if (t.status === "error") return this.needsConfirm({ id: key } as Message, null, `${t.display_id} is in the error state — restart it first`);
    const fromChat = !!loadMessage(this.d.db, key);
    const send = this.d.outbox.commandInput(t.uuid, key, { kind: "send", text, marker: marker(), message_id: fromChat ? key : undefined });
    const inputs: EmitInput[] = [send.input];
    if (fromChat) inputs.unshift({ type: "dispatch.completed", payload: { message_id: key, patch: { task_uuid: t.uuid } } });
    if (["done", "needs_review", "cancelled"].includes(t.status)) inputs.push({ type: "task.status_changed", task_uuid: t.uuid, payload: { status: "queued", patch: { status: "queued", queued_at: now(), qhead: true, ended_at: null } } });
    this.d.log.emitMany(inputs); this.d.outbox.kick(t.uuid); void this.d.scheduler.pump();
  }
  interrupt(taskUuid: string) {
    const t = loadTask(this.d.db, taskUuid)!;
    this.d.outbox.cancelPending(taskUuid, ["spawn", "send", "resume"], "interrupt"); if (t.session_id) cancelPermissions(this.d.pendingPermissions, t.session_id);
    if (t.status === "queued") { this.status(t, "cancelled", { ended_at: now(), qhead: false }); this.chat(chatFor("cancelled", t, "")); return; }
    if (t.process_state === "alive" || t.process_state === "starting") this.d.outbox.enqueue(taskUuid, `interrupt:${now()}`, { kind: "stop", reason: "interrupt" });
    this.status(t, "cancelled", { ended_at: now(), question: null }); this.d.permits.releaseTask(taskUuid, "interrupt"); this.chat(chatFor("cancelled", t, "")); void this.d.scheduler.pump();
  }
  retry(taskUuid: string) {
    this.d.outbox.cancelPending(taskUuid, ["send", "resume"], "retry");
    // A task parked in `error` by a spawn whose outcome relay could not read has a spawn command left at `unknown`,
    // and an unknown head blocks the task's queue for good (I8) — so a resume queued behind it would never run, the
    // task would sit at `starting` with no process, and it would hold its slot until relay was reinstalled (the
    // watchdog only scans live processes, recovery's requeue branch wants a pending/running spawn, and reconcile
    // reads `starting` as entitled). Cancelling that spawn is no better: the session it may have started is the only
    // one this task has, so the resume behind it dies on `no session_id to resume` and leaks the slot the same way.
    // Re-running the spawn is what "restart" means here — apply() adopts the session if it did come up after all
    // (same name, our owner stamp) and otherwise spawns a fresh one.
    const spawn = this.d.db.query("select id from commands where task_uuid=? and kind='spawn' and state in ('pending','unknown') order by rowid limit 1").get(taskUuid) as any;
    if (spawn) this.d.log.emit({ type: "command.requeued", task_uuid: taskUuid, payload: { id: spawn.id } });
    else this.d.outbox.enqueue(taskUuid, `retry:${now()}`, { kind: "resume", prompt: "Continue from where you stopped. When you are finished, report with a RELAY: done block.", marker: marker() });
    this.d.scheduler.enqueue(taskUuid, true); void this.d.scheduler.pump();
  }
  close(taskUuid: string) {
    const t = loadTask(this.d.db, taskUuid)!; if (t.status === "closed") return;
    this.d.outbox.cancelPending(taskUuid, ["spawn", "send", "resume"], "close"); if (t.session_id) cancelPermissions(this.d.pendingPermissions, t.session_id);
    // Disposal covers EVERY generation the task ran, not just the one it is bound to — the forks left the rest
    // registered. Enqueued stops-then-removes, because the generations share one worktree: nothing may be removed
    // while anything is still running in it.
    if (t.process_state === "alive" || t.process_state === "starting") this.d.outbox.enqueue(taskUuid, `close-stop:${now()}`, { kind: "stop", reason: "close" });
    this.d.outbox.reapStops(t, "close");
    this.d.outbox.enqueue(taskUuid, `close-rm:${now()}`, { kind: "rm" });
    this.d.outbox.reapRms(t);
    this.d.permits.releaseTask(taskUuid, "close"); this.status(t, "closed", { closed_at: now(), ended_at: t.ended_at ?? now(), question: null, qhead: false }); void this.d.scheduler.pump();
  }
  attachLease(taskUuid: string, by: string) {
    const t = loadTask(this.d.db, taskUuid)!;
    this.d.log.emit({ type: "attach.acquired", task_uuid: taskUuid, payload: { by, patch: { attach_state: "leased", attached_by: by } } });
    return { command: t.process_state === "alive" && t.short_id ? `claude attach ${t.short_id}` : `claude --resume ${t.session_id}` };
  }
  releaseAttach(taskUuid: string) { this.d.log.emit({ type: "attach.released", task_uuid: taskUuid, payload: { patch: { attach_state: "none", attached_by: null } } }); void this.d.outbox.run(taskUuid); }
  pause() {
    this.d.log.emit({ type: "system.paused", payload: {} });
    for (const r of this.d.db.query("select uuid from tasks where status in ('starting','running') and parent_uuid is null and process_state='alive'").all() as any[]) {
      this.d.log.emit({ type: "task.patched", task_uuid: r.uuid, payload: { patch: { paused: true } } });
      this.d.outbox.enqueue(r.uuid, `pause:${now()}`, { kind: "stop", reason: "kill switch" });                // stop runs even while attached (B1: kill switch wins)
    }
  }
  resumeAll() {
    this.d.log.emit({ type: "system.resumed", payload: {} });
    for (const r of this.d.db.query("select uuid from tasks where paused=1").all() as any[]) this.d.outbox.enqueue(r.uuid, `unpause:${now()}`, { kind: "resume", prompt: "The kill switch has been released. Continue from where you stopped.", marker: marker() });
    void this.d.outbox.runAll(); void this.d.scheduler.pump();
  }
  // ---- worker signals ----------------------------------------------------------------------------
  private onCrash(t: Task, reason: string) {
    this.status(t, "error", { ended_at: now(), question: null }); this.d.permits.releaseTask(t.uuid, "crashed");
    this.chat(chatFor("error", loadTask(this.d.db, t.uuid)!, `Session ended (${reason}) — use Restart to --resume`)); void this.d.scheduler.pump();
  }
  /** §11: subscription/rate limit seen in worker output → global pause + banner; the task goes back to the queue head for the resume. */
  private onRateLimit(t: Task, text: string) {
    if (this.paused()) return;
    const when = text.match(/(\d{1,2}:\d{2}\s*(?:am|pm)?|\d+\s*(?:minutes?|hours?|분|시간))/i)?.[1];
    this.chat(sysMsg(`⛔ Looks like a subscription usage limit — kill switch ON${when ? ` (expected reset: ${when})` : ""}. Check, then resume.`, t.uuid));
    this.pause();
  }
  private onStop(t: Task, body: any) {
    if (t.paused) return;
    const v = verdict(body, t);
    this.d.log.emit({ type: "hook.verdict", task_uuid: t.uuid, payload: { verdict: v.status, reason: v.reason } });
    if (v.status === "running") { void this.d.outbox.run(t.uuid); return; }
    if (v.status === "waiting_input") { this.status(t, "waiting_input", { question: v.question }); this.d.permits.releaseTask(t.uuid, "waiting_input"); this.chat(chatFor(v.reason === "marker blocked" ? "blocked" : "question", t, v.question!.text + (v.question!.options.length ? ` (${v.question!.options.join(" / ")})` : ""))); }
    else { this.status(t, v.status, { ended_at: now(), last_summary: v.summary ?? t.last_summary }); this.d.permits.releaseTask(t.uuid, v.status); if (v.status === "done") this.chat(chatFor("completed", t, v.summary ?? "")); else this.chat(chatFor("error", t, `Needs review — ${v.reason}: ${v.summary ?? ""}`)); }
    void this.d.outbox.run(t.uuid);                                      // turn boundary: deliver anything that waited for the turn to end
    void this.d.scheduler.pump();
  }
}

export type Services = { ingestDeps: IngestDeps; tasks: TaskService; outbox: Outbox; scheduler: Scheduler; dispatcher: Dispatcher; permits: PermitPool; pendingPermissions: Map<string, PendingPermission> };
