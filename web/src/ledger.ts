// web/src/ledger.ts — the request ledger: one row per user message, what relay did with it, and whether anything came back.
// Pure derivation over the snapshot the dashboard already holds (messages + tasks); the rail in app.js is only a view of it.
import type { Message, MessageSource, Task, TaskStatus } from "@shared/types.ts";
import { isAsk, stripAsk } from "@shared/ask.ts";
import { stKey, stLabel, type StKey } from "./consts.ts";

/** The `?` prefix is a keyboard gesture, not part of what the user asked — the gateway strips it before storing,
 *  but rows written before the declaration moved into `ask` still carry one. */
const plain = (text: string) => (isAsk(text) ? stripAsk(text) : text);

/** What happened to the request. Read off dispatch_state and the dispatcher's recorded decision — nothing is guessed. */
export type Disposition = "deciding" | "new_task" | "split" | "routed" | "delivered" | "answered" | "fastpath" | "close_request" | "needs_confirm" | "failed";
/** Sort and filter tier. `needs_you` is the point of the view: those requests are stranded until the user acts. */
export type Bucket = "needs_you" | "in_flight" | "settled";
export type RequestAction = "redispatch" | "answer" | "restart" | "close";
export type AnswerKind = "answer" | "summary" | "question" | "error";

export interface RequestRow {
  id: string; text: string; createdAt: number; source: MessageSource;
  disposition: Disposition; dispositionLabel: string;
  taskUuid: string | null; taskId: string | null; taskIds: string[]; taskStatus: TaskStatus | null;
  state: string; st: StKey; bucket: Bucket;
  answer: string | null; answerKind: AnswerKind | null;
  actions: RequestAction[];
}

const ORDER: Record<Bucket, number> = { needs_you: 0, in_flight: 1, settled: 2 };
const ATTENTION = new Set<TaskStatus>(["error", "waiting_input", "needs_review"]);
const ACTIVE = new Set<TaskStatus>(["queued", "starting", "running"]);
const RETRYABLE = new Set<TaskStatus>(["error", "cancelled", "needs_review"]);
const ENDED = new Set<TaskStatus>(["done", "needs_review", "cancelled", "error"]);

function dispositionOf(m: Message): Disposition {
  switch (m.dispatch_state) {
    case "pending": case "deciding": return "deciding";
    case "fastpath": return "fastpath";
    case "needs_confirm": return "needs_confirm";
    case "failed": return "failed";
    case "direct": return "delivered";                                         // a reply aimed at a task, or an answer to its question — never went to the dispatcher
    default: switch (m.dispatch_json?.action) {                                // "dispatched"
      case "new_task": return "new_task";
      case "split": return "split";
      case "route_to_task": return "routed";
      case "answer_directly": return "answered";
      case "close_task": return "close_request";
      default: return m.task_uuid ? "routed" : "answered";
    }
  }
}

const labelOf = (d: Disposition, taskId: string | null): string => {
  const t = taskId ?? "a task";
  return d === "deciding" ? "Deciding" : d === "new_task" ? `Started ${t}` : d === "split" ? "Split into separate tasks" : d === "routed" ? `Routed into ${t}` : d === "delivered" ? `Sent to ${t}`
    : d === "answered" ? "Answered by the dispatcher" : d === "fastpath" ? "Answered from the status fast path" : d === "close_request" ? `Close ${t} requested`
      : d === "needs_confirm" ? "Waiting for your confirmation" : "Dispatch failed";
};

/** A split makes several tasks and `messages.task_uuid` holds only the first (C.4.4), so the row's state is decided by
 *  the piece that most needs reading: anything waiting on the user, else anything still running, else the first. */
const lead = (ts: Task[]): Task | null => ts.find((t) => ATTENTION.has(t.status)) ?? ts.find((t) => ACTIVE.has(t.status)) ?? ts[0] ?? null;

/** The state of the disposition, not of the task: a request stuck at needs_confirm is "waiting for you" even when the task it named is running. */
function stateOf(d: Disposition, m: Message, task: Task | null): { state: string; st: StKey } {
  if (d === "deciding") return { state: "Deciding", st: "run" };
  if (d === "needs_confirm") return { state: "Waiting for you", st: "wait" };
  if (d === "failed") return { state: "Failed", st: "err" };
  if (task) return { state: stLabel(task.status), st: stKey(task.status) };
  if (m.task_uuid) return { state: "Archived", st: "closed" };                 // the snapshot drops tasks closed over 24h ago
  return { state: "Answered", st: "done" };
}

function bucketOf(d: Disposition, m: Message, task: Task | null): Bucket {
  if (d === "needs_confirm" || d === "failed") return "needs_you";
  if (d === "deciding") return "in_flight";
  if (d === "close_request") return task && task.status !== "closed" ? "needs_you" : "settled";
  if (!task) return "settled";                                                 // answered, fast path, or a task archived out of the snapshot
  return ATTENTION.has(task.status) ? "needs_you" : ACTIVE.has(task.status) ? "in_flight" : "settled";
}

function answerOf(d: Disposition, m: Message, task: Task | null, trail: Message[], outcome: Map<string, string>): { answer: string | null; answerKind: AnswerKind | null } {
  const trailText = (role: Message["role"]) => trail.find((t) => t.role === role)?.text ?? null;
  if (d === "failed") return { answer: m.dispatch_error, answerKind: "error" };
  if (d === "needs_confirm") {
    // The prompt TaskService.needsConfirm() promotes — matched on its opening words, because the trail also holds
    // the `dispatcher · …` badge row the same decision emits, and that one says nothing about why this stalled.
    const dec = m.dispatch_json; const prompt = trail.find((t) => t.role === "system" && t.text.startsWith("Routing needs confirmation"))?.text;
    return { answer: prompt ?? (dec ? `Routing needs confirmation — candidate: ${dec.action}${dec.task_id ? ` ${dec.task_id}` : ""}` : "Routing needs confirmation."), answerKind: "question" };
  }
  if (task?.status === "waiting_input" && task.question) return { answer: task.question.text, answerKind: "question" };
  if (task && ENDED.has(task.status)) return { answer: task.last_summary ?? (m.task_uuid ? outcome.get(m.task_uuid) ?? null : null), answerKind: task.status === "error" ? "error" : "summary" };
  if (d === "answered") return { answer: m.dispatch_json?.answer ?? trailText("dispatcher_answer"), answerKind: "answer" };
  if (d === "fastpath") return { answer: trailText("dispatcher_answer"), answerKind: "answer" };
  return { answer: null, answerKind: null };
}

function actionsOf(d: Disposition, task: Task | null): RequestAction[] {
  const a: RequestAction[] = [];
  if (d === "needs_confirm" || d === "failed") a.push("redispatch");
  if (task?.status === "waiting_input") a.push("answer");
  if (task && RETRYABLE.has(task.status)) a.push("restart");
  if (d === "close_request" && task && task.status !== "closed") a.push("close");
  return a;
}

/**
 * One row per user message: the request, its disposition, the live state of that disposition, and the answer if one came back.
 * Ordered needs-you first, then newest first — the two stranded requests must not sit below forty settled ones.
 */
export function requestRows(messages: Message[], tasks: Record<string, Task>): RequestRow[] {
  const ordered = [...messages].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  // A task's outcome is linked by task_uuid, never by position: the summary lands long after the request, usually after other requests.
  const outcome = new Map<string, string>();
  for (const m of ordered) if (m.task_uuid && (m.role === "worker_summary" || m.role === "error")) outcome.set(m.task_uuid, m.text);
  const rows: RequestRow[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const m = ordered[i]; if (m.role !== "user") continue;
    // Dispatcher replies (fast-path answer, needs-confirm prompt) carry no task_uuid, so they are linked by position: everything up to the next request belongs to this one.
    const trail: Message[] = [];
    for (let j = i + 1; j < ordered.length && ordered[j].role !== "user"; j++) trail.push(ordered[j]);
    // A split records every task it made in dispatch_json.task_ids; every other decision names at most the one in task_uuid.
    const own = (m.dispatch_json?.task_ids ?? []).map((id) => Object.values(tasks).find((t) => t.display_id === id)).filter((t): t is Task => !!t);
    const first = m.task_uuid ? tasks[m.task_uuid] ?? null : null;
    const all = own.length ? own : first ? [first] : [];
    const task = lead(all) ?? first;
    const d = dispositionOf(m); const taskId = task?.display_id ?? null;
    const taskIds = own.length ? m.dispatch_json!.task_ids! : taskId ? [taskId] : [];
    rows.push({
      id: m.id, text: plain(m.text), createdAt: m.created_at, source: m.source,
      disposition: d, dispositionLabel: labelOf(d, taskId),
      taskUuid: m.task_uuid, taskId, taskIds, taskStatus: task?.status ?? null,
      ...stateOf(d, m, task), bucket: bucketOf(d, m, task),
      ...answerOf(d, m, task, trail, outcome), actions: actionsOf(d, task),
    });
  }
  return rows.sort((a, b) => ORDER[a.bucket] - ORDER[b.bucket] || b.createdAt - a.createdAt);
}

export const needsYou = (rows: RequestRow[]) => rows.filter((r) => r.bucket === "needs_you").length;
