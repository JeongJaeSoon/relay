// src/core/tasks.ts — orchestration around tasks: decisions → tasks/commands, verdicts → statuses, user actions.
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { DispatchDecision, Message, Task, TaskQuestion, TaskSize } from "@shared/types.ts";
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

interface Deps { db: Database; log: EventLog; cfg: Config; permits: PermitPool; scheduler: Scheduler; outbox: Outbox; projectNameOf: (id: string) => string; pendingPermissions: Map<string, PendingPermission> }
/** 8 hex chars embedded as `[relay #xxxxxxxx]`; the worker echoes it back through UserPromptSubmit so relay can confirm delivery. */
const marker = () => randomBytes(4).toString("hex");
const markerFor = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 8);
const sysMsg = (text: string, taskUuid: string | null = null): MessageInput => ({ id: ulid(), role: "system", source: "user", client_message_id: null, dispatch_state: "direct", text, task_uuid: taskUuid, reply_to_task_uuid: null, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: now() });

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
        const proj = this.d.db.query("select id from projects where name=? or id=?").get(dec.project ?? "", dec.project ?? "") as any;
        if (!proj) return this.needsConfirm(msg, dec, `project ${dec.project} not registered`);
        const size: TaskSize = dec.size ?? "normal"; const uuid = newUuid(); const num = (this.d.db.query("select coalesce(max(num),0)+1 n from tasks where parent_uuid is null").get() as any).n; const t = now();
        const task: Task = { uuid, num, display_id: displayId(num), project_id: proj.id, title: dec.title ?? msg.text.slice(0, 24), status: "queued", size, effort: this.d.cfg.worker.effort[size], model: this.d.cfg.worker.model,
          session_id: null, short_id: null, worktree_path: null, branch: null, base_sha: null, process_state: "none", process_generation: 0, turn_state: "idle", attach_state: "none", attached_by: null, paused: false,
          last_summary: null, last_step: null, question: null, parent_uuid: null, agent_id: null, agent_type: null, queued_at: t, qhead: false, started_at: null, ended_at: null, created_at: t, updated_at: t, closed_at: null, usage_tokens: 0, summary_json: null };
        const spawn = this.d.outbox.commandInput(uuid, msg.id, { kind: "spawn", spec: this.spec(task, `[relay #${markerFor(msg.id)}] ${task.display_id} · project=${this.d.projectNameOf(proj.id)} · size=${size}\n\n${dec.prompt ?? msg.text}`) });
        this.d.log.emitMany([{ type: "task.created", task_uuid: uuid, causation_id: msg.id, payload: task }, done({ task_uuid: uuid }), badgeIn, { type: "message.received", task_uuid: uuid, payload: chatFor("started", task, "", this.d.projectNameOf(proj.id)) }, spawn.input]);   // task row first (FK), then the message patch, badge, started chat, spawn
        void this.d.scheduler.pump(); return;
      }
      case "route_to_task": {
        const t = this.byDisplay(dec.task_id!); if (!t) return this.needsConfirm(msg, dec, `task ${dec.task_id} not found`);
        if (t.status === "error") { this.d.log.emitMany([done({ task_uuid: t.uuid }), badgeIn]); return this.needsConfirm(msg, null, `${t.display_id}은(는) 오류 상태 — 먼저 재시작하세요`); }
        if (t.status === "waiting_input" && t.question?.source === "permission") { this.d.log.emitMany([done({ task_uuid: t.uuid }), badgeIn]); this.answer(t.uuid, dec.prompt ?? msg.text, null); return; }
        const send = this.d.outbox.commandInput(t.uuid, msg.id, { kind: "send", text: dec.prompt ?? msg.text, marker: marker(), message_id: msg.id });
        const inputs: EmitInput[] = [done({ task_uuid: t.uuid }), badgeIn];
        if (t.status === "waiting_input") inputs.push({ type: "question.answered", task_uuid: t.uuid, causation_id: msg.id, payload: { text: dec.prompt ?? msg.text, patch: { question: null } } });
        inputs.push(send.input);
        if (["done", "needs_review", "cancelled", "waiting_input"].includes(t.status)) inputs.push({ type: "task.status_changed", task_uuid: t.uuid, payload: { status: "queued", patch: { status: "queued", queued_at: now(), qhead: true, ended_at: null } } });
        this.d.log.emitMany(inputs); this.d.outbox.kick(t.uuid); void this.d.scheduler.pump(); return;
      }
      case "answer_directly": { this.d.log.emitMany([done(), badgeIn, { type: "message.received", payload: { ...sysMsg(dec.answer ?? ""), role: "dispatcher_answer" } }]); return; }
      case "close_task": { const t = this.byDisplay(dec.task_id!); if (!t) return this.needsConfirm(msg, dec, `task ${dec.task_id} not found`); this.d.log.emitMany([done({ task_uuid: t.uuid }), badgeIn, { type: "message.received", task_uuid: t.uuid, payload: sysMsg(`${t.display_id} ${t.title}을(를) 종료할까요? [종료 확인: POST /api/tasks/${t.uuid}/close]`, t.uuid) }]); return; }
    }
  }
  needsConfirm(msg: Message, dec: DispatchDecision | null, reason: string) {
    const active = this.d.db.query("select display_id, title from tasks where parent_uuid is null and status not in ('closed') order by updated_at desc limit 6").all() as any[];
    const opts = active.map((t) => `${t.display_id} ${t.title}`).join(" / ");
    const inputs: EmitInput[] = [{ type: "message.received", payload: sysMsg(`라우팅 확인 필요 (${reason}${dec ? `, 후보: ${dec.action}${dec.task_id ? " " + dec.task_id : ""}` : ""}). 어느 작업인가요? ${opts || "(활성 작업 없음 — 새 작업이면 프로젝트를 알려주세요)"}`) }];
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
    if (t.status === "error") return this.needsConfirm({ id: key } as Message, null, `${t.display_id}은(는) 오류 상태 — 먼저 재시작하세요`);
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
    this.d.outbox.enqueue(taskUuid, `retry:${now()}`, { kind: "resume", prompt: "중단된 지점부터 이어서 진행하라. 끝나면 RELAY: done 블록으로 보고하라.", marker: marker() });
    this.d.scheduler.enqueue(taskUuid, true); void this.d.scheduler.pump();
  }
  close(taskUuid: string) {
    const t = loadTask(this.d.db, taskUuid)!; if (t.status === "closed") return;
    this.d.outbox.cancelPending(taskUuid, ["spawn", "send", "resume"], "close"); if (t.session_id) cancelPermissions(this.d.pendingPermissions, t.session_id);
    if (t.process_state === "alive" || t.process_state === "starting") this.d.outbox.enqueue(taskUuid, `close-stop:${now()}`, { kind: "stop", reason: "close" });
    this.d.outbox.enqueue(taskUuid, `close-rm:${now()}`, { kind: "rm" });
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
    for (const r of this.d.db.query("select uuid from tasks where paused=1").all() as any[]) this.d.outbox.enqueue(r.uuid, `unpause:${now()}`, { kind: "resume", prompt: "kill switch가 해제됐다. 중단된 지점부터 이어서 진행하라.", marker: marker() });
    void this.d.outbox.runAll(); void this.d.scheduler.pump();
  }
  // ---- worker signals ----------------------------------------------------------------------------
  private onCrash(t: Task, reason: string) {
    this.status(t, "error", { ended_at: now(), question: null }); this.d.permits.releaseTask(t.uuid, "crashed");
    this.chat(chatFor("error", loadTask(this.d.db, t.uuid)!, `세션이 종료됨(${reason}) — 재시작 버튼으로 --resume`)); void this.d.scheduler.pump();
  }
  /** §11: subscription/rate limit seen in worker output → global pause + banner; the task goes back to the queue head for the resume. */
  private onRateLimit(t: Task, text: string) {
    if (this.paused()) return;
    const when = text.match(/(\d{1,2}:\d{2}\s*(?:am|pm)?|\d+\s*(?:minutes?|hours?|분|시간))/i)?.[1];
    this.chat(sysMsg(`⛔ 구독 사용량 한도로 보이는 오류 — kill switch ON${when ? ` (재개 예상: ${when})` : ""}. 확인 후 재개하세요.`, t.uuid));
    this.pause();
  }
  private onStop(t: Task, body: any) {
    if (t.paused) return;
    const v = verdict(body, t);
    this.d.log.emit({ type: "hook.verdict", task_uuid: t.uuid, payload: { verdict: v.status, reason: v.reason } });
    if (v.status === "running") { void this.d.outbox.run(t.uuid); return; }
    if (v.status === "waiting_input") { this.status(t, "waiting_input", { question: v.question }); this.d.permits.releaseTask(t.uuid, "waiting_input"); this.chat(chatFor(v.reason === "marker blocked" ? "blocked" : "question", t, v.question!.text + (v.question!.options.length ? ` (${v.question!.options.join(" / ")})` : ""))); }
    else { this.status(t, v.status, { ended_at: now(), last_summary: v.summary ?? t.last_summary }); this.d.permits.releaseTask(t.uuid, v.status); if (v.status === "done") this.chat(chatFor("completed", t, v.summary ?? "")); else this.chat(chatFor("error", t, `검토 필요 — ${v.reason}: ${v.summary ?? ""}`)); }
    void this.d.outbox.run(t.uuid);                                      // turn boundary: deliver anything that waited for the turn to end
    void this.d.scheduler.pump();
  }
}

export type Services = { ingestDeps: IngestDeps; tasks: TaskService; outbox: Outbox; scheduler: Scheduler; dispatcher: Dispatcher; permits: PermitPool; pendingPermissions: Map<string, PendingPermission> };
