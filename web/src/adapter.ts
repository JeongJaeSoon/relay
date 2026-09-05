// web/src/adapter.ts — the only place that knows both worlds: server Task/Message/SystemState (store) and the demo engine's S/N/LEDGER/chat globals (app.js).
import type { EventEnvelope, ForeignSession, Message, Project, Task } from "@shared/types.ts";
import { stripAsk } from "@shared/ask.ts";
import * as api from "./api.ts";
import { stKey, stLabel, type StKey } from "./consts.ts";
import { requestRows } from "./ledger.ts";
import { diffNotifs, type NotifKind } from "./notify.ts";
import { store } from "./store.ts";
export interface DemoTaskCore { id: string; uuid: string; num: number; title: string; project: string; size: string; status: StKey; statusLabel: string; step: string; startedAt: Date | null; endedAt: Date | null; question: { q: string; chips: string[] } | null; sub: boolean; parent: string | null; children: string[]; sid: string; proc: string; gen: number; attached: string | null; worktree: string | null; branch: string; queuedAt: number; qhead: boolean; paused: boolean; model: string; effort: string; agentType: string | null; bornAt: number; tags: string[]; pending: null; msgUntil: number }
export interface DemoEvent { id: number; at: Date; txt: string; payload: string | null }
/** What the demo engine holds in S.tasks: the server-derived core plus the engine's own fields (layout position, timeline) that survive updates. */
export type DemoTask = DemoTaskCore & { events: DemoEvent[]; timers: unknown[]; x: number; y: number };
const TERMINAL = new Set(["done", "needs_review", "error", "cancelled"]);
type Ctx = { projects: Project[]; tasks: Record<string, Task> };
const D: any = globalThis;                                                     // app.js globals (classic script): S, N, LEDGER, gwEl, msgs, el, ttagBtn, chat*, notify, withdrawNotif, relayout, refresh, renderBanner, renderSettings, renderLedger, select, centerOn
const PROC: Record<string, string> = { none: "not started", starting: "starting", alive: "running", stopped: "stopped", crashed: "crashed" };
// ---- pure ------------------------------------------------------------------------------------------
export function toDemoTask(t: Task, ctx: Ctx): DemoTaskCore {
  const parent = t.parent_uuid ? ctx.tasks[t.parent_uuid] : null;
  return { id: t.display_id, uuid: t.uuid, num: t.num, title: t.title, project: ctx.projects.find((p) => p.id === t.project_id)?.name ?? t.project_id, size: t.size, status: stKey(t.status), statusLabel: stLabel(t.status),
    step: t.status === "waiting_input" && t.question ? `❓ ${t.question.text}` : t.status === "queued" ? "Waiting for an agent slot" : TERMINAL.has(t.status) && t.last_summary ? t.last_summary : t.last_step ?? t.last_summary ?? "", startedAt: t.started_at ? new Date(t.started_at) : null, endedAt: t.ended_at ? new Date(t.ended_at) : null,
    question: t.status === "waiting_input" && t.question ? { q: t.question.text, chips: t.question.options.length ? t.question.options : ["OK"] } : null,
    sub: !!t.parent_uuid, parent: parent?.display_id ?? null, children: Object.values(ctx.tasks).filter((c) => c.parent_uuid === t.uuid && c.status !== "closed").sort((a, b) => a.num - b.num).map((c) => c.display_id),
    sid: t.short_id ?? "—", proc: t.process_state === "alive" ? (t.turn_state === "busy" ? "running" : "idle") : PROC[t.process_state] ?? t.process_state, gen: t.process_generation, attached: t.attach_state !== "none" ? t.attached_by : null,
    worktree: t.worktree_path, branch: t.branch ?? `relay-${t.uuid.replace(/-/g, "").slice(0, 8)}`, queuedAt: t.queued_at ?? 0, qhead: t.qhead, paused: t.paused, model: t.model.replace("claude-", ""), effort: t.effort, agentType: t.agent_type, bornAt: t.created_at, tags: [], pending: null, msgUntil: 0 };
}
/** A session relay only watches. Deliberately NOT a DemoTask: it has no id, project, size, permit, branch or verdict,
 *  and the graph must never let one be mistaken for a task relay is running. */
export interface DemoForeign { key: string; title: string; sid: string; short: string; cwd: string; state: "running" | "idle" | "unknown"; stateLabel: string; kind: string; pid: number | null; startedAt: Date | null; firstSeen: Date; lastSeen: Date }
export function toDemoForeign(f: ForeignSession): DemoForeign {
  const dir = (f.cwd ?? "").replace(/\/+$/, "");
  const state = f.busy == null ? "unknown" : f.busy ? "running" : "idle";     // `agents --json` says nothing about a session it reports no status for
  return { key: f.session_id, title: f.name?.trim() || dir.split("/").pop() || `session ${f.session_id.slice(0, 8)}`,
    sid: f.session_id, short: f.short_id ?? "—", cwd: dir || "—", state, stateLabel: { running: "Running", idle: "Idle", unknown: "Unknown" }[state],
    kind: f.kind === "bg" ? "background" : f.kind ?? "", pid: f.pid, startedAt: f.started_at ? new Date(f.started_at) : null, firstSeen: new Date(f.first_seen), lastSeen: new Date(f.last_seen) };
}
const demoOf = (uuid: string | null | undefined): DemoTask | undefined => { if (!uuid) return undefined; const t = store.state.tasks[uuid]; return t ? D.S?.tasks?.get(t.display_id) ?? undefined : undefined; };
/** The question as the user typed it — gated on the declaration, never on the text: a `?` a non-typing source sent
 *  is part of the request and must render. Only rows written before `ask` existed still carry a prefix to strip. */
const plain = (m: Message) => (m.ask ? stripAsk(m.text) : m.text);
export function badgeParts(m: Message, ctx: Ctx): { kind: string; parts: string[]; task?: DemoTask; retry?: boolean; judging: boolean } {
  const b = stateBadges(m, ctx);
  return m.ask ? { ...b, parts: ["ask", ...b.parts] } : b;                       // the same field the dispatcher reads, not a re-read of the text
}
function stateBadges(m: Message, ctx: Ctx): { kind: string; parts: string[]; task?: DemoTask; retry?: boolean; judging: boolean } {
  const st = m.task_uuid ? ctx.tasks[m.task_uuid] : null; const task: DemoTask | undefined = st ? ((D.S?.tasks?.get(st.display_id) as DemoTask | undefined) ?? { ...toDemoTask(st, ctx), events: [], timers: [], x: 0, y: 0 }) : undefined; const d = m.dispatch_json;
  switch (m.dispatch_state) {
    case "pending": return { kind: "gateway", parts: ["⏳ Accepted"], judging: false };
    case "deciding": return { kind: "dispatcher", parts: ["● Deciding (fable)"], judging: true };
    case "fastpath": return { kind: "gateway", parts: ["fast-path"], judging: false };
    case "needs_confirm": return { kind: "dispatcher", parts: ["Needs confirm"], judging: false };
    case "failed": return { kind: "dispatcher", parts: [`failed · ${m.dispatch_error ?? ""}`], retry: true, judging: false };
    case "direct": return { kind: "↪ Reply", parts: [], task, judging: false };
    default: return { kind: "dispatcher", parts: d ? (d.action === "split" ? ["split", String(d.task_ids?.length ?? 0), (d.task_ids ?? []).join(" ")] : [d.action, ...(d.size ? [d.size] : []), ...(d.project ? [d.project] : [])]) : [], task, judging: false };
  }
}
export function eventLine(e: EventEnvelope): DemoEvent {
  const p: any = e.payload ?? {}; const txt = e.type.startsWith("hook.") ? `${e.type.slice(5)}${p.tool_name ? " · " + p.tool_name : ""}${p.notification_type ? " · " + p.notification_type : ""}` : e.type === "send.outcome" ? `delivery ${p.outcome} (${p.via})` : e.type === "message.sent" ? `${p.direction === "in" ? "← " : "→ "}${p.to ?? p.from ?? ""}` : e.type;
  return { id: e.seq, at: new Date(e.occurred_at), txt, payload: e.payload && typeof e.payload === "object" ? JSON.stringify(e.payload, null, 1).slice(0, 4000) : null };
}
export interface NotifOp { op: "add" | "withdraw"; taskUuid: string; kind?: NotifKind; title?: string; body?: string }
export interface NotifQueue { observe(t: Task): void; drain(): { ops: NotifOp[]; chips: string[] } }
/** Notifications are decided as each frame lands, not when the renderer next runs: Chrome pauses rAF in a hidden
 *  tab, so a coalesced render would only ever see the newest task state and every transition in between — exactly
 *  the ones the notification centre exists for — would be lost. The DOM work still happens in the rAF flush. */
export function createNotifQueue(): NotifQueue {
  const last = new Map<string, Task>(); const ops: NotifOp[] = []; const chips = new Set<string>();
  return {
    observe(t) {
      const prev = last.get(t.uuid); last.set(t.uuid, t);
      if (!prev) return;                                                       // first sighting (snapshot or task.created) never notifies
      const { add, withdraw } = diffNotifs(prev, t);
      for (const w of withdraw) ops.push({ op: "withdraw", taskUuid: w.taskUuid, kind: w.kind });
      for (const a of add) ops.push({ op: "add", taskUuid: a.taskUuid, kind: a.kind, title: a.title, body: a.body });
      if (prev.question && !t.question) chips.add(t.uuid);                     // the question was answered elsewhere — grey its chat chips out
    },
    drain() { const c = [...chips]; chips.clear(); return { ops: ops.splice(0), chips: c }; },
  };
}
/** The server states the dispatcher's decision twice: on the user message as dispatch_json — which the adapter renders
 *  as the demo's badge chips with a clickable task tag — and again as a plain system chat row (crosswalk §4,
 *  "판단 완료 시 chat.message system 행"). Only the chips are kept; the text row is the same thing, worse. */
export const isDispatcherBadgeRow = (m: Message) => m.role === "system" && m.text.startsWith("dispatcher · ");
/** The timeline is the worker's observation stream — exactly what the WS carries as task.event. The detail fetch
 *  returns the task's WHOLE event log instead, which is mostly relay's own bookkeeping: over a hundred task.patched
 *  projection writes per task, plus command/permit/process rows whose effect the node and detail already show.
 *  Both sources go through this filter so loading the history does not change what the timeline means. */
export const isTimelineEvent = (type: string) => type.startsWith("hook.") || type === "send.outcome" || type === "message.sent";
export const closeConfirmUuid = (text: string) => text.match(/\[close confirm: POST \/api\/tasks\/([^/\]]+)\/close\]/)?.[1] ?? null;
// ---- browser ----------------------------------------------------------------------------------------
const note = (s: string) => D.chatNote?.(s);
const run = (label: string, p: Promise<unknown>) => p.catch((e) => note(`${label} failed: ${String((e as Error).message ?? e)}`));
/** The task a promoted `question` chat row may draw its chips from — `null` sends the row to the plain chat line instead.
 *  The row outlives the question (it stays in the snapshot after the task answers) while toDemoTask fills `question` only
 *  while the task is waiting, and chatQuestion reads `t.question.q`. Checking only that the task exists is the shape that
 *  took the whole sync() down on reload (#24) — and came back once already, so the branch now lives here, where a test can reach it. */
export const promotedQuestionTask = (m: Pick<Message, "role">, task: DemoTask | undefined): DemoTask | null => (m.role === "question" && task?.question ? task : null);
/** Successful detail loads are cached; a failed request can be selected again without evicting a newer load. */
export function createDetailLoader<T>(fetchDetail: (uuid: string) => Promise<T>) {
  let selected: { uuid: string } | null = null;
  return (uuid: string): Promise<T> | null => {
    if (selected?.uuid === uuid) return null;
    const attempt = { uuid }; selected = attempt;
    return fetchDetail(uuid).catch(error => { if (selected === attempt) selected = null; throw error; });
  };
}
export function installAdapter() {
  const S = D.S; const notifs = createNotifQueue(); const badgeRows = new Map<string, HTMLElement>(); const drawn = new Set<string>(); let raf = 0;
  const loadDetail = createDetailLoader(api.taskDetail);
  const selectionKey = "relay-selected-task"; let restoreSelection = true;
  const submitMessage = api.createMessageSender();
  const ctx = (): Ctx => ({ projects: store.state.projects, tasks: store.state.tasks });
  const relay = {
    send: async (text: string, ask = false, askTask?: string) => {
      try { await submitMessage(text, { ask, askTask }); return true; }
      catch (e) { note(`Send failed — your draft is still here. ${(e as Error).message}`); return false; }
    },
    answer: (t: DemoTask, choice: string) => run("answer", api.answer(t.uuid, choice)),
    stop: (t: DemoTask) => run("stop", api.interrupt(t.uuid)), restart: (t: DemoTask) => run("restart", api.retry(t.uuid)), archive: (t: DemoTask) => run("archive", api.close(t.uuid)),
    attach: async (t: DemoTask) => { try { const { command } = await api.attachLease(t.uuid); await navigator.clipboard?.writeText(command).catch(() => {}); note(`Copied to clipboard: ${command} (run it in a terminal — relay attach releases the lease when it ends)`); } catch (e) { note(`attach failed: ${(e as Error).message}`); } },
    pause: () => run("kill switch", S.paused ? api.resumeAll() : api.pause()),
    setMax: (n: number) => run("limit change", api.patchSettings({ max_concurrent_agents: Math.max(1, n) })),
    registerProject: (p: { name: string; path: string; description: string; keywords: string[] }) => run("project registration", api.registerProject(p)), removeProject: (id: string) => run("project removal", api.removeProject(id)),
    redispatch: (messageId: string) => run("retry", api.redispatch(messageId)),
    stopForeign: (key: string) => run("stop", api.stopForeign(key)),           // the one write the dashboard can aim at a session relay does not own
    loadDetail: (t: DemoTask) => { const request = loadDetail(t.uuid); if (!request) return; request.then((d) => { const live = new Set(t.events.map((e) => e.id)); t.events = [...(d.events as EventEnvelope[]).filter((e) => isTimelineEvent(e.type)).map(eventLine).filter((e) => !live.has(e.id)), ...t.events].slice(-200); if (S.sel === t.id) D.refresh(); }).catch(() => {}); },
  };
  D.relay = relay;
  const syncTasks = (uuids: Iterable<string>) => {
    let changed = false;
    for (const uuid of uuids) {
      const t = store.state.tasks[uuid]; if (!t) continue; const next = toDemoTask(t, ctx()); const cur: DemoTask | undefined = S.tasks.get(next.id);
      if (cur) Object.assign(cur, next); else S.tasks.set(next.id, { ...next, events: [], timers: [], x: 0, y: 0 } satisfies DemoTask);   // keep x/y/events on update → the .node element and its transition survive
      changed = true;
    }
    return changed;
  };
  /** Keeps S.foreign in step with the store, preserving each node's layout position the way syncTasks does. */
  const syncForeign = () => {
    const seen = new Set<string>();
    for (const f of store.state.foreign) {
      const next = toDemoForeign(f); seen.add(next.key);
      const cur = S.foreign.get(next.key); if (cur) Object.assign(cur, next); else S.foreign.set(next.key, { ...next, x: 0, y: 0 });
    }
    for (const k of [...S.foreign.keys()]) if (!seen.has(k)) { S.foreign.delete(k); if (S.fsel === k) S.fsel = null; }
  };
  const syncSystem = () => {
    const sys = store.state.sys; if (sys) { S.maxw = sys.max_concurrent_agents; S.paused = sys.paused; S.usage = sys.today_tokens; S.running = sys.running; S.recovering = sys.recovering; S.version = sys.version; S.delivery = sys.delivery_method; S.dailyCeiling = sys.daily_ceiling; S.cliDrift = sys.cli_drift; }
    S.projects = store.state.projects;
    S.conn = store.state.conn === "resync" ? "replaying" : store.state.conn; S.lastSeq = store.state.seq;
    D.renderBanner(); D.renderSettings(); D.renderSidebar();   // the pool card carries the paused chip and the running/queued counts, and a pause frame changes no task
    D.gwEl.classList.toggle("judging", store.state.messages.some((m) => m.dispatch_state === "deciding")); D.gwEl.querySelector(".gw-s").textContent = D.gwEl.classList.contains("judging") ? "dispatcher deciding (fable)" : `:${location.port || 80} · always listening`;
  };
  const badgeRow = (m: Message) => {
    const b = badgeParts(m, ctx()); const row = D.el("div", "m-badges"); row.append(D.el("span", "badge k" + (b.judging ? " judging" : ""), b.kind)); b.parts.forEach((p) => row.append(D.el("span", "badge", p)));
    if (b.task) row.append(D.ttagBtn(b.task)); if (b.retry) { const r = D.el("button", "nc-btn", "Retry"); r.addEventListener("click", () => relay.redispatch(m.id)); row.append(r); }
    return row;
  };
  const syncMessages = (ids: Iterable<string>) => {
    const byId = new Map(store.state.messages.map((m) => [m.id, m]));
    for (const id of ids) {
      const m = byId.get(id); if (!m) continue;
      if (isDispatcherBadgeRow(m)) { drawn.add(id); continue; }                   // the badge chips under the user message already say this
      if (drawn.has(id)) { const old = badgeRows.get(id); if (old && m.role === "user") { const fresh = badgeRow(m); old.replaceWith(fresh); badgeRows.set(id, fresh); } continue; }
      drawn.add(id); const task = demoOf(m.task_uuid);
      if (m.role === "user") { D.chatUser(plain(m)); const wrap = D.el("div", "m-row"); const row = badgeRow(m); wrap.append(row); D.msgs.append(wrap); badgeRows.set(id, row); }
      else if (promotedQuestionTask(m, task)) D.chatQuestion(task!);   // the task may have left waiting_input since: chatQuestion reads t.question.q, and the plain row below already carries the question text
      else if (m.role === "system") { const uuid = closeConfirmUuid(m.text); if (uuid) { const wrap = D.el("div", "m-row"); wrap.append(D.el("div", "m-sys", m.text.split(" [close confirm")[0])); const b = D.el("button", "act danger", "Close"); b.addEventListener("click", () => run("close", api.close(uuid))); wrap.append(b); D.msgs.append(wrap); } else D.chatMsg(task ?? null, m.text); }
      else D.chatMsg(task ?? null, m.text);                                    // worker_summary | error | dispatcher_answer
    }
    D.scrollChat?.();
  };
  /** The ledger is derived, never accumulated: a task changing status changes the disposition of every request that landed in it. */
  const syncLedger = () => { D.LEDGER.length = 0; D.LEDGER.push(...requestRows(store.state.messages, store.state.tasks)); };
  const syncEvents = (uuids: Iterable<string>) => { for (const uuid of uuids) { const t = demoOf(uuid); if (!t) continue; const list = store.state.events[uuid] ?? []; const have = new Set(t.events.map((e) => e.id)); for (const e of list) if (!have.has(e.seq) && isTimelineEvent(e.type)) t.events.push(eventLine(e)); if (t.events.length > 200) t.events.splice(0, t.events.length - 200); if (S.sel === t.id) D.refresh(); } };
  const flushNotifs = () => {                                                  // decisions were made at frame time; the DOM work happens here, once per render
    const { ops, chips } = notifs.drain();
    for (const o of ops) { const d = demoOf(o.taskUuid); if (!d) continue; if (o.op === "withdraw") D.withdrawNotif(d.id, o.kind); else D.notify(o.kind, d, o.body); }
    for (const uuid of chips) { const d = demoOf(uuid); if (d) document.querySelectorAll(`.m-chips[data-task="${d.id}"] .chip`).forEach((b) => ((b as HTMLButtonElement).disabled = true)); }
  };
  const sync = () => {
    raf = 0; const d = store.drain(); const all = d.all;
    const tasksChanged = syncTasks(all ? Object.keys(store.state.tasks) : d.tasks);
    flushNotifs();                                                             // after syncTasks so S.tasks holds the demo task the notification points at
    if (all || d.sys || d.projects) syncSystem();
    if (all || d.messages.size) syncMessages(all ? store.state.messages.map((m) => m.id) : d.messages);
    if (d.events.size) syncEvents(d.events);
    const foreignChanged = all || d.foreign; if (foreignChanged) syncForeign();
    if (all || d.messages.size || d.tasks.size) { syncLedger(); if (!all && !tasksChanged && !foreignChanged) D.renderLedger(); }   // otherwise relayout() → refresh() draws it
    if (tasksChanged || foreignChanged || all) D.relayout();                   // one layout+render per animation frame, whatever arrived
    if (all && restoreSelection) {
      restoreSelection = false;
      const saved = sessionStorage.getItem(selectionKey);
      const task = saved ? demoOf(saved) : null;
      if (task) D.select(task.id); else sessionStorage.removeItem(selectionKey);
    }
  };
  store.subscribe((f) => {
    if (f) { if (f.type === "task.created" || f.type === "task.updated") notifs.observe(f.task); }
    else for (const t of Object.values(store.state.tasks)) notifs.observe(t);  // snapshot or connection change: re-baseline, and notify for whatever moved while we were disconnected
    if (!raf) raf = requestAnimationFrame(sync);
  });
  const origSelect = D.select; D.select = (id: string | null) => {
    origSelect(id); const t = id ? S.tasks.get(id) : null;
    if (t) { sessionStorage.setItem(selectionKey, t.uuid); relay.loadDetail(t); }
    else sessionStorage.removeItem(selectionKey);
  };   // persist the UUID, since display IDs can be reused by a fresh database
  const origClear = D.clearSel; D.clearSel = () => { sessionStorage.removeItem(selectionKey); origClear(); };
  const origForeign = D.selectForeign; D.selectForeign = (key: string) => { sessionStorage.removeItem(selectionKey); origForeign(key); };
}
