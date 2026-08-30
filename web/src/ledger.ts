// web/src/ledger.ts — the request ledger: one row per user message, what relay did with it, and whether anything came back.
// Pure derivation over the snapshot the dashboard already holds (messages + tasks); the rail in app.js is only a view of it.
import type { Message, MessageSource, Task, TaskStatus } from "@shared/types.ts";
import { stKey, stLabel, type StKey } from "./consts.ts";

/** What happened to the request. Read off dispatch_state and the dispatcher's recorded decision — nothing is guessed. */
export type Disposition = "deciding" | "new_task" | "routed" | "delivered" | "answered" | "fastpath" | "close_request" | "needs_confirm" | "failed";
/** Sort and filter tier. `needs_you` is the point of the view: those requests are stranded until the user acts. */
export type Bucket = "needs_you" | "in_flight" | "settled";
export type RequestAction = "redispatch" | "answer" | "restart" | "close";
export type AnswerKind = "answer" | "summary" | "question" | "error";

export interface RequestRow {
  id: string; text: string; createdAt: number; source: MessageSource;
  disposition: Disposition; dispositionLabel: string;
  taskUuid: string | null; taskId: string | null; taskStatus: TaskStatus | null;
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
      case "route_to_task": return "routed";
      case "answer_directly": return "answered";
      case "close_task": return "close_request";
      default: return m.task_uuid ? "routed" : "answered";
    }
  }
}

const labelOf = (d: Disposition, taskId: string | null): string => {
  const t = taskId ?? "a task";
  return d === "deciding" ? "Deciding" : d === "new_task" ? `Started ${t}` : d === "routed" ? `Routed into ${t}` : d === "delivered" ? `Sent to ${t}`
    : d === "answered" ? "Answered by the dispatcher" : d === "fastpath" ? "Answered from the status fast path" : d === "close_request" ? `Close ${t} requested`
      : d === "needs_confirm" ? "Waiting for your confirmation" : "Dispatch failed";
};

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
    const dec = m.dispatch_json;
    return { answer: trailText("system") ?? (dec ? `Routing needs confirmation — candidate: ${dec.action}${dec.task_id ? ` ${dec.task_id}` : ""}` : "Routing needs confirmation."), answerKind: "question" };
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
    const task = m.task_uuid ? tasks[m.task_uuid] ?? null : null;
    const d = dispositionOf(m); const taskId = task?.display_id ?? null;
    rows.push({
      id: m.id, text: m.text, createdAt: m.created_at, source: m.source,
      disposition: d, dispositionLabel: labelOf(d, taskId),
      taskUuid: m.task_uuid, taskId, taskStatus: task?.status ?? null,
      ...stateOf(d, m, task), bucket: bucketOf(d, m, task),
      ...answerOf(d, m, task, trail, outcome), actions: actionsOf(d, task),
    });
  }
  return rows.sort((a, b) => ORDER[a.bucket] - ORDER[b.bucket] || b.createdAt - a.createdAt);
}

export const needsYou = (rows: RequestRow[]) => rows.filter((r) => r.bucket === "needs_you").length;
