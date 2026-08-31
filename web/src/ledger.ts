// web/src/ledger.ts — the request ledger: one row per user message, what relay did with it, and whether anything came back.
// Pure derivation over the snapshot the dashboard already holds (messages + tasks); the rail in app.js is only a view of it.
import type { Message, MessageSource, Task, TaskStatus } from "@shared/types.ts";
import { stripAsk } from "@shared/ask.ts";
import { stKey, stLabel, type StKey } from "./consts.ts";

/** The `?` prefix is a keyboard gesture, not part of what the user asked — but only when it WAS one, which is what
 *  `ask` says. A `?` body from github/slack/cron/mcp is work, and renders whole. Only pre-`ask` rows carry a prefix. */
const plain = (m: Message) => (m.ask ? stripAsk(m.text) : m.text);

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

/** The two dispatcher replies that arrive as bare chat rows: the fast-path or direct answer, and the prompt
 *  TaskService.needsConfirm() promotes. The prompt is matched on its opening words because the same decision also
 *  emits the `dispatcher · …` badge row, and that one says nothing about why the request stalled. */
/** The reason sendTo() gives a reply aimed at a task that is in the error state (tasks.ts:166). */
const ERR_STATE = /^Routing needs confirmation \(.+ is in the error state/;
type ReplyKind = "answer" | "prompt";
const replyKindOf = (m: Message): ReplyKind | null =>
  m.role === "dispatcher_answer" ? "answer" : m.role === "system" && m.text.startsWith("Routing needs confirmation") ? "prompt" : null;
/** Which reply a request is owed. `answered` counts even when the decision already carries the answer text: the row
 *  was still emitted, so it has to be consumed here or it shifts onto the next request. */
const awaitedBy = (d: Disposition): ReplyKind | null => (d === "needs_confirm" ? "prompt" : d === "answered" || d === "fastpath" ? "answer" : null);
/** A reply aimed at a task, which TaskService answers inside the HTTP handler instead of handing to the dispatcher.
 *  routes.ts:61 records one as `direct` with its target in reply_to_task_uuid and never enqueues it, and it is the
 *  only writer of that field — so this separates an off-chain request from a chain one exactly. */
const offChain = (m: Message) => m.reply_to_task_uuid !== null;

/**
 * Links each dispatcher reply to the request it answers.
 *
 * Not by position: the dispatcher decides one message at a time on a global chain (Dispatcher.enqueue), while a
 * message is recorded the moment it arrives — and a decision is a `claude -p` call plus a possible retry, so it takes
 * seconds. A second request sent inside that window is recorded *before* the first request's reply, and "everything
 * up to the next request" hands request B the answer to A. That is the default with two requests in flight, not a
 * rare race. A reply row carries no task_uuid and no causation id, so nothing on it links it back.
 *
 * What does hold is the order — but for one exception, which is worth stating flatly because it is not derivable
 * from this file: EVERY claimable reply is emitted on the dispatcher chain, in the order the requests were made,
 * EXCEPT the reply-to-errored-task path, which is identified by its text instead. Hence two passes:
 *
 *  1. That exception. routes.ts records the message and TaskService.answer() runs through to needsConfirm()
 *     synchronously in the same HTTP handler, so its prompt is written while chain requests are still inside
 *     `claude -p` — ahead of prompts for requests made long before it. In the shared queue it would take the oldest
 *     waiting request's prompt and shift every later claim, which is worse than the positional bug it replaces:
 *     instead of one row degrading to its own candidate, every row confidently shows someone else's reason.
 *     It is matched on content, not on position. sendTo() is the only producer of this reason and it names the task
 *     the request replied to, so the prompt is found wherever it sits — position is not consulted at all. Adjacency
 *     would not do: `created_at` is milliseconds and ulid() is not monotonic, so a chain prompt sharing that
 *     millisecond can sort between the message and its own prompt, or ahead of both, and nothing distinguishes it by
 *     position. Leaving this prompt unclaimed is not neutral either — it flows into pass 2 and lands on a chain row.
 *  2. Everything the chain produced, claimed in order: the k-th reply of a kind goes to the k-th request still
 *     awaiting that kind. A reply nothing is waiting for is dropped.
 *
 * The chain emits the same reason for a route_to_task at tasks.ts:59, but that request has a null reply_to_task_uuid
 * and so never reaches pass 1; were both to name one task the two texts would be equal anyway, so no row can show
 * words that are not its own. A target missing from `tasks` is the one case that cannot be named — it should not
 * arise, since the snapshot carries every task that is not closed (snapshot.ts:9) and an errored one never is — and
 * there the prompt is retired unclaimed rather than left in the pool, so that row degrades and no other row is
 * wrong. Degrading is always preferred to guessing here: a wrong reason reads as authoritative, a missing one does
 * not.
 *
 * Both passes rest on a request in an awaiting state always having its reply row — which holds because needsConfirm(),
 * applyDecision() and the fast path each emit the state patch and the reply row through one emitMany, and because the
 * snapshot is the newest 200 messages by created_at, so a request inside that window has its later reply inside it
 * too. That is a property of those emitters, not something this file can enforce: a new one that patches the state
 * and emits its reply separately would strand a request at the head of the queue and shift every later claim.
 */
function claimReplies(ordered: Message[], tasks: Record<string, Task>): Map<string, Message> {
  const claimed = new Map<string, Message>();
  const taken = new Set<string>();                                             // reply rows already spoken for
  for (const m of ordered) {                                                   // 1 — off-chain confirmations, on content
    if (m.role !== "user" || !offChain(m) || awaitedBy(dispositionOf(m)) !== "prompt") continue;
    const free = (n: Message) => !taken.has(n.id) && replyKindOf(n) === "prompt";
    // The exact opening needsConfirm() builds from sendTo()'s reason (tasks.ts:139, 166). Two replies to one errored
    // task produce identical prompts, so first-free keeps them in request order.
    const target = tasks[m.reply_to_task_uuid!];
    const hit = target && ordered.find((n) => free(n) && n.text.startsWith(`Routing needs confirmation (${target.display_id} is in the error state`));
    if (hit) { claimed.set(m.id, hit); taken.add(hit.id); continue; }
    // Target absent from the snapshot, so the prompt cannot be named. Leaving it in the pool is not neutral — pass 2
    // would hand it to a chain request — so retire one unclaimed instead: this row degrades, no other row is wrong.
    const stray = ordered.find((n) => free(n) && ERR_STATE.test(n.text));
    if (stray) taken.add(stray.id);
  }
  const waiting: Record<ReplyKind, Message[]> = { answer: [], prompt: [] };    // 2 — the chain's replies, in order
  for (const m of ordered) {
    if (m.role === "user") {
      if (offChain(m)) continue;                                               // claimed above, and never queued
      const k = awaitedBy(dispositionOf(m)); if (k) waiting[k].push(m);
      continue;
    }
    const kind = replyKindOf(m); if (!kind || taken.has(m.id)) continue;
    const req = waiting[kind].shift();
    if (req) { claimed.set(req.id, m); taken.add(m.id); }
  }
  return claimed;
}

function answerOf(d: Disposition, m: Message, task: Task | null, reply: Message | null, outcome: Map<string, string>): { answer: string | null; answerKind: AnswerKind | null } {
  if (d === "failed") return { answer: m.dispatch_error, answerKind: "error" };
  if (d === "needs_confirm") {
    const dec = m.dispatch_json;
    return { answer: reply?.text ?? (dec ? `Routing needs confirmation — candidate: ${dec.action}${dec.task_id ? ` ${dec.task_id}` : ""}` : "Routing needs confirmation."), answerKind: "question" };
  }
  if (task?.status === "waiting_input" && task.question) return { answer: task.question.text, answerKind: "question" };
  // Keyed on the task the row names, not on m.task_uuid: for a split that holds only the first piece (C.4.4), while
  // `task` is the piece lead() picked. onCrash leaves last_summary null and puts the reason in an error chat row, so
  // this fallback is the live path for a failure — off the wrong key it printed a sibling's success line as one.
  if (task && ENDED.has(task.status)) return { answer: task.last_summary ?? outcome.get(task.uuid) ?? null, answerKind: task.status === "error" ? "error" : "summary" };
  if (d === "answered") return { answer: m.dispatch_json?.answer ?? reply?.text ?? null, answerKind: "answer" };
  if (d === "fastpath") return { answer: reply?.text ?? null, answerKind: "answer" };
  return { answer: null, answerKind: null };
}

function actionsOf(d: Disposition, task: Task | null): RequestAction[] {
  const a: RequestAction[] = [];
  if (d === "needs_confirm" || d === "failed") a.push("redispatch");
  if (task?.status === "waiting_input" && task.question) a.push("answer");   // the chips are the question's options — without one the action renders nothing and the row is a dead end
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
  const replies = claimReplies(ordered, tasks);
  const rows: RequestRow[] = [];
  for (const m of ordered) {
    if (m.role !== "user") continue;
    // A split records every task it made in dispatch_json.task_ids; every other decision names at most the one in task_uuid.
    const own = (m.dispatch_json?.task_ids ?? []).map((id) => Object.values(tasks).find((t) => t.display_id === id)).filter((t): t is Task => !!t);
    const first = m.task_uuid ? tasks[m.task_uuid] ?? null : null;
    const all = own.length ? own : first ? [first] : [];
    const task = lead(all) ?? first;
    const d = dispositionOf(m); const taskId = task?.display_id ?? null;
    const taskIds = own.length ? m.dispatch_json!.task_ids! : taskId ? [taskId] : [];
    rows.push({
      id: m.id, text: plain(m), createdAt: m.created_at, source: m.source,
      disposition: d, dispositionLabel: labelOf(d, taskId),
      taskUuid: m.task_uuid, taskId, taskIds, taskStatus: task?.status ?? null,
      ...stateOf(d, m, task), bucket: bucketOf(d, m, task),
      ...answerOf(d, m, task, replies.get(m.id) ?? null, outcome), actions: actionsOf(d, task),
    });
  }
  return rows.sort((a, b) => ORDER[a.bucket] - ORDER[b.bucket] || b.createdAt - a.createdAt);
}

export const needsYou = (rows: RequestRow[]) => rows.filter((r) => r.bucket === "needs_you").length;
