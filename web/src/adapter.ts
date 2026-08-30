// web/src/adapter.ts — the only place that knows both worlds: server Task/Message/SystemState (store) and the demo engine's S/N/DLOG/chat globals (app.js).
import type { EventEnvelope, Message, Project, Task } from "@shared/types.ts";
import * as api from "./api.ts";
import { stKey, stLabel, type StKey } from "./consts.ts";
import { diffNotifs } from "./notify.ts";
import { store } from "./store.ts";
export interface DemoTaskCore { id: string; uuid: string; num: number; title: string; project: string; size: string; status: StKey; statusLabel: string; step: string; startedAt: Date | null; endedAt: Date | null; question: { q: string; chips: string[] } | null; sub: boolean; parent: string | null; children: string[]; sid: string; proc: string; gen: number; attached: string | null; worktree: string | null; branch: string; queuedAt: number; qhead: boolean; paused: boolean; model: string; effort: string; agentType: string | null; bornAt: number; tags: string[]; pending: null; msgUntil: number }
export interface DemoEvent { id: number; at: Date; txt: string; payload: string | null }
/** What the demo engine holds in S.tasks: the server-derived core plus the engine's own fields (layout position, timeline) that survive updates. */
export type DemoTask = DemoTaskCore & { events: DemoEvent[]; timers: unknown[]; x: number; y: number };
const TERMINAL = new Set(["done", "needs_review", "error", "cancelled"]);
type Ctx = { projects: Project[]; tasks: Record<string, Task> };
const D: any = globalThis;                                                     // app.js globals (classic script): S, N, DLOG, gwEl, msgs, el, ttagBtn, chat*, notify, withdrawNotif, relayout, refresh, renderBanner, renderSettings, renderDlog, select, centerOn
const PROC: Record<string, string> = { none: "미시작", starting: "시작 중", alive: "실행 중", stopped: "정지", crashed: "크래시" };
// ---- pure ------------------------------------------------------------------------------------------
export function toDemoTask(t: Task, ctx: Ctx): DemoTaskCore {
  const parent = t.parent_uuid ? ctx.tasks[t.parent_uuid] : null;
  return { id: t.display_id, uuid: t.uuid, num: t.num, title: t.title, project: ctx.projects.find((p) => p.id === t.project_id)?.name ?? t.project_id, size: t.size, status: stKey(t.status), statusLabel: stLabel(t.status),
    step: TERMINAL.has(t.status) && t.last_summary ? t.last_summary : t.last_step ?? (t.question ? `❓ ${t.question.text}` : t.last_summary ?? ""), startedAt: t.started_at ? new Date(t.started_at) : null, endedAt: t.ended_at ? new Date(t.ended_at) : null,
    question: t.status === "waiting_input" && t.question ? { q: t.question.text, chips: t.question.options.length ? t.question.options : ["확인"] } : null,
    sub: !!t.parent_uuid, parent: parent?.display_id ?? null, children: Object.values(ctx.tasks).filter((c) => c.parent_uuid === t.uuid && c.status !== "closed").sort((a, b) => a.num - b.num).map((c) => c.display_id),
    sid: t.short_id ?? "—", proc: t.process_state === "alive" ? (t.turn_state === "busy" ? "실행 중" : "유휴") : PROC[t.process_state] ?? t.process_state, gen: t.process_generation, attached: t.attach_state !== "none" ? t.attached_by : null,
    worktree: t.worktree_path, branch: t.branch ?? `relay-${t.uuid.replace(/-/g, "").slice(0, 8)}`, queuedAt: t.queued_at ?? 0, qhead: t.qhead, paused: t.paused, model: t.model.replace("claude-", ""), effort: t.effort, agentType: t.agent_type, bornAt: t.created_at, tags: [], pending: null, msgUntil: 0 };
}
const demoOf = (uuid: string | null | undefined): DemoTask | undefined => { if (!uuid) return undefined; const t = store.state.tasks[uuid]; return t ? D.S?.tasks?.get(t.display_id) ?? undefined : undefined; };
export function badgeParts(m: Message, ctx: Ctx): { kind: string; parts: string[]; task?: DemoTask; retry?: boolean; judging: boolean } {
  const st = m.task_uuid ? ctx.tasks[m.task_uuid] : null; const task: DemoTask | undefined = st ? ((D.S?.tasks?.get(st.display_id) as DemoTask | undefined) ?? { ...toDemoTask(st, ctx), events: [], timers: [], x: 0, y: 0 }) : undefined; const d = m.dispatch_json;
  switch (m.dispatch_state) {
    case "pending": return { kind: "gateway", parts: ["⏳ 접수"], judging: false };
    case "deciding": return { kind: "dispatcher", parts: ["● 판단 중 (fable)"], judging: true };
    case "fastpath": return { kind: "gateway", parts: ["fast-path"], judging: false };
    case "needs_confirm": return { kind: "dispatcher", parts: ["확인 필요"], judging: false };
    case "failed": return { kind: "dispatcher", parts: [`failed · ${m.dispatch_error ?? ""}`], retry: true, judging: false };
    case "direct": return { kind: "↪ 답장", parts: [], task, judging: false };
    default: return { kind: "dispatcher", parts: d ? [d.action, ...(d.size ? [d.size] : []), ...(d.project ? [d.project] : [])] : [], task, judging: false };
  }
}
export function dlogEntry(m: Message, ctx: Ctx) {
  const st = m.task_uuid ? ctx.tasks[m.task_uuid] : null; const d = m.dispatch_json; const judging = m.dispatch_state === "pending" || m.dispatch_state === "deciding";
  const result = judging ? null : m.dispatch_state === "failed" ? { action: "failed", note: m.dispatch_error ?? "실패" } : m.dispatch_state === "fastpath" ? { action: "fast-path", note: "즉답 (LLM 0회)" } : m.dispatch_state === "needs_confirm" ? { action: d?.action ?? "needs_confirm", note: "확인 필요" } : { action: d?.action ?? (m.dispatch_state === "direct" ? "reply" : "—"), ids: st ? [st.display_id] : [] };
  return { id: m.id, messageId: m.id, text: m.text, status: judging ? "judging" as const : "done" as const, result };
}
export function eventLine(e: EventEnvelope): DemoEvent {
  const p: any = e.payload ?? {}; const txt = e.type.startsWith("hook.") ? `${e.type.slice(5)}${p.tool_name ? " · " + p.tool_name : ""}${p.notification_type ? " · " + p.notification_type : ""}` : e.type === "send.outcome" ? `전달 ${p.outcome} (${p.via})` : e.type === "message.sent" ? `${p.direction === "in" ? "← " : "→ "}${p.to ?? p.from ?? ""}` : e.type;
  return { id: e.seq, at: new Date(e.occurred_at), txt, payload: e.payload && typeof e.payload === "object" ? JSON.stringify(e.payload, null, 1).slice(0, 4000) : null };
}
export const closeConfirmUuid = (text: string) => text.match(/\[종료 확인: POST \/api\/tasks\/([^/\]]+)\/close\]/)?.[1] ?? null;
// ---- browser ----------------------------------------------------------------------------------------
const note = (s: string) => D.chatNote?.(s);
const run = (label: string, p: Promise<unknown>) => p.catch((e) => note(`${label} 실패: ${String((e as Error).message ?? e)}`));
export function installAdapter() {
  const S = D.S; const last = new Map<string, Task>(); const badgeRows = new Map<string, HTMLElement>(); const drawn = new Set<string>(); let raf = 0; let loadedDetail: string | null = null;
  const ctx = (): Ctx => ({ projects: store.state.projects, tasks: store.state.tasks });
  const relay = {
    send: (text: string) => run("전송", api.sendMessage(text)),
    answer: (t: DemoTask, choice: string) => run("답변", api.answer(t.uuid, choice)),
    stop: (t: DemoTask) => run("중단", api.interrupt(t.uuid)), restart: (t: DemoTask) => run("재시작", api.retry(t.uuid)), archive: (t: DemoTask) => run("보관", api.close(t.uuid)),
    attach: async (t: DemoTask) => { try { const { command } = await api.attachLease(t.uuid); await navigator.clipboard?.writeText(command).catch(() => {}); note(`클립보드에 복사: ${command} (터미널에서 실행 — 끝나면 relay attach가 lease를 해제)`); } catch (e) { note(`attach 실패: ${(e as Error).message}`); } },
    pause: () => run("kill switch", S.paused ? api.resumeAll() : api.pause()),
    setMax: (n: number) => run("상한 변경", api.patchSettings({ max_concurrent_agents: Math.max(1, n) })),
    registerProject: (p: { name: string; path: string; description: string; keywords: string[] }) => run("프로젝트 등록", api.registerProject(p)), removeProject: (id: string) => run("프로젝트 삭제", api.removeProject(id)),
    redispatch: (messageId: string) => run("재시도", api.redispatch(messageId)),
    loadDetail: (t: DemoTask) => { if (loadedDetail === t.uuid) return; loadedDetail = t.uuid; api.taskDetail(t.uuid).then((d) => { const live = new Set(t.events.map((e) => e.id)); t.events = [...(d.events as EventEnvelope[]).map(eventLine).filter((e) => !live.has(e.id)), ...t.events].slice(-200); if (S.sel === t.id) D.refresh(); }).catch(() => {}); },
  };
  D.relay = relay;
  const syncTasks = (uuids: Iterable<string>) => {
    let changed = false;
    for (const uuid of uuids) {
      const t = store.state.tasks[uuid]; if (!t) continue; const next = toDemoTask(t, ctx()); const prev = last.get(uuid); const cur: DemoTask | undefined = S.tasks.get(next.id);
      if (cur) Object.assign(cur, next); else S.tasks.set(next.id, { ...next, events: [], timers: [], x: 0, y: 0 } satisfies DemoTask);   // keep x/y/events on update → the .node element and its transition survive
      const d: DemoTask = S.tasks.get(next.id);
      if (prev) { const { add, withdraw } = diffNotifs(prev, t); for (const w of withdraw) D.withdrawNotif(d.id, w.kind); for (const a of add) D.notify(a.kind, d, a.body); if (prev.question && !t.question) document.querySelectorAll(`.m-chips[data-task="${d.id}"] .chip`).forEach((b) => ((b as HTMLButtonElement).disabled = true)); }
      last.set(uuid, t); changed = true;
    }
    return changed;
  };
  const syncSystem = () => {
    const sys = store.state.sys; if (sys) { S.maxw = sys.max_concurrent_agents; S.paused = sys.paused; S.usage = sys.today_tokens; S.running = sys.running; S.recovering = sys.recovering; S.version = sys.version; S.delivery = sys.delivery_method; S.dailyCeiling = sys.daily_ceiling; }
    S.projects = store.state.projects;
    S.conn = store.state.conn === "resync" ? "replaying" : store.state.conn; S.lastSeq = store.state.seq;
    D.renderBanner(); D.renderSettings();
    D.gwEl.classList.toggle("judging", store.state.messages.some((m) => m.dispatch_state === "deciding")); D.gwEl.querySelector(".gw-s").textContent = D.gwEl.classList.contains("judging") ? "dispatcher 판단 중 (fable)" : `:${location.port || 80} · 상시 수신`;
  };
  const badgeRow = (m: Message) => {
    const b = badgeParts(m, ctx()); const row = D.el("div", "m-badges"); row.append(D.el("span", "badge k" + (b.judging ? " judging" : ""), b.kind)); b.parts.forEach((p) => row.append(D.el("span", "badge", p)));
    if (b.task) row.append(D.ttagBtn(b.task)); if (b.retry) { const r = D.el("button", "nc-btn", "재시도"); r.addEventListener("click", () => relay.redispatch(m.id)); row.append(r); }
    return row;
  };
  const syncMessages = (ids: Iterable<string>) => {
    const byId = new Map(store.state.messages.map((m) => [m.id, m]));
    for (const id of ids) {
      const m = byId.get(id); if (!m) continue;
      if (drawn.has(id)) { const old = badgeRows.get(id); if (old && m.role === "user") { const fresh = badgeRow(m); old.replaceWith(fresh); badgeRows.set(id, fresh); } continue; }
      drawn.add(id); const task = demoOf(m.task_uuid);
      if (m.role === "user") { D.chatUser(m.text); const wrap = D.el("div", "m-row"); const row = badgeRow(m); wrap.append(row); D.msgs.append(wrap); badgeRows.set(id, row); }
      else if (m.role === "question" && task) D.chatQuestion(task);
      else if (m.role === "system") { const uuid = closeConfirmUuid(m.text); if (uuid) { const wrap = D.el("div", "m-row"); wrap.append(D.el("div", "m-sys", m.text.split(" [종료 확인")[0])); const b = D.el("button", "act danger", "종료"); b.addEventListener("click", () => run("종료", api.close(uuid))); wrap.append(b); D.msgs.append(wrap); } else D.chatMsg(task ?? null, m.text); }
      else D.chatMsg(task ?? null, m.text);                                    // worker_summary | error | dispatcher_answer
    }
    D.scrollChat?.();
    const users = store.state.messages.filter((m) => m.role === "user").slice(-20).reverse(); D.DLOG.length = 0; for (const m of users) D.DLOG.push(dlogEntry(m, ctx())); D.renderDlog();
  };
  const syncEvents = (uuids: Iterable<string>) => { for (const uuid of uuids) { const t = demoOf(uuid); if (!t) continue; const list = store.state.events[uuid] ?? []; const have = new Set(t.events.map((e) => e.id)); for (const e of list) if (!have.has(e.seq)) t.events.push(eventLine(e)); if (t.events.length > 200) t.events.splice(0, t.events.length - 200); if (S.sel === t.id) D.refresh(); } };
  const sync = () => {
    raf = 0; const d = store.drain(); const all = d.all;
    const tasksChanged = syncTasks(all ? Object.keys(store.state.tasks) : d.tasks);
    if (all || d.sys || d.projects) syncSystem();
    if (all || d.messages.size) syncMessages(all ? store.state.messages.map((m) => m.id) : d.messages);
    if (d.events.size) syncEvents(d.events);
    if (tasksChanged || all) D.relayout();                                     // one layout+render per animation frame, whatever arrived
  };
  store.subscribe(() => { if (!raf) raf = requestAnimationFrame(sync); });
  const origSelect = D.select; D.select = (id: string | null) => { origSelect(id); const t = id ? S.tasks.get(id) : null; if (t) relay.loadDetail(t); };   // first selection pulls the 200-event history
}
