// web/src/conversation-scope.ts — pure current/history partition for the conversation surfaces.
import type { Message, Task } from "@shared/types.ts";
import { claimReplies, type RequestRow } from "./ledger.ts";

/** A completed task remains part of the current workspace. Only explicit closure, a missing task, or a missing/closed
 * ancestor puts it in History. Children cannot outlive a parent that is no longer present in this snapshot. */
export function isCurrentTask(taskUuid: string, tasks: Record<string, Task>): boolean {
  const seen = new Set<string>();
  let task = tasks[taskUuid];
  while (task) {
    if (task.status === "closed" || seen.has(task.uuid)) return false;
    seen.add(task.uuid);
    if (!task.parent_uuid) return true;
    task = tasks[task.parent_uuid];
  }
  return false;
}

const taskByDisplayId = (id: string, tasks: Record<string, Task>) =>
  Object.values(tasks).find((task) => task.display_id === id);

/** The direct task pointer is incomplete for a split: it names the first child only, while task_ids names every piece. */
function messageTaskRefs(message: Message, tasks: Record<string, Task>): { hasReference: boolean; uuids: string[] } {
  const uuids = [message.task_uuid, message.reply_to_task_uuid].filter((id): id is string => !!id);
  const splitIds = message.dispatch_json?.task_ids ?? [];
  const candidateIds = [...splitIds, ...(message.dispatch_json?.task_id ? [message.dispatch_json.task_id] : [])];
  for (const id of candidateIds) {
    const task = taskByDisplayId(id, tasks);
    if (task) uuids.push(task.uuid);
  }
  return { hasReference: uuids.length > 0 || candidateIds.length > 0, uuids: [...new Set(uuids)] };
}

const hasCurrentTask = (uuids: readonly string[], tasks: Record<string, Task>) =>
  uuids.some((uuid) => isCurrentTask(uuid, tasks));

/**
 * Returns the Current conversation. A task-bound row survives when at least one of its referenced tasks is still
 * current, so closing one piece of a split does not hide its live sibling. A taskless user request stays visible:
 * pending/failed requests have no task by design, and a completed standalone exchange has no durable archive link.
 *
 * Bare dispatcher replies have no causal ID of their own. The ledger's reply matcher supplies the owner, including
 * interleaved asynchronous requests; an unclaimed system/global row is not guessed to belong to any request.
 */
export function currentMessages(messages: Message[], tasks: Record<string, Task>): Message[] {
  const ordered = messages.map((message, index) => ({ message, index }))
    .sort((a, b) => a.message.created_at - b.message.created_at || a.message.id.localeCompare(b.message.id));
  const current = new Set<string>();
  const requestCurrent = new Map<string, boolean>();
  const replies = claimReplies(ordered.map(({ message }) => message), tasks);
  const replyOwner = new Map<string, string>();
  for (const [requestId, reply] of replies) replyOwner.set(reply.id, requestId);

  for (const { message } of ordered) {
    const refs = messageTaskRefs(message, tasks);
    const ownCurrent = !refs.hasReference || hasCurrentTask(refs.uuids, tasks);
    if (message.role === "user") {
      requestCurrent.set(message.id, ownCurrent);
      if (ownCurrent) current.add(message.id);
      continue;
    }
    if (refs.hasReference ? ownCurrent : requestCurrent.get(replyOwner.get(message.id) ?? "") === true) current.add(message.id);
  }
  return messages.filter((message) => current.has(message.id));
}

function rowTaskRefs(row: RequestRow, tasks: Record<string, Task>): { hasReference: boolean; uuids: string[] } {
  const uuids = [...(row.taskUuids ?? []), ...(row.taskUuid ? [row.taskUuid] : [])];
  for (const id of row.taskIds) {
    const task = taskByDisplayId(id, tasks);
    if (task) uuids.push(task.uuid);
  }
  return { hasReference: uuids.length > 0 || row.taskIds.length > 0, uuids: [...new Set(uuids)] };
}

/** Current request rows follow the same rule as messages. Rows with no task reference remain visible: that includes
 * pending, needs-confirmation, and failed dispatcher work, whose task is intentionally null. */
export function currentRequestRows(rows: RequestRow[], tasks: Record<string, Task>): RequestRow[] {
  return rows.filter((row) => {
    const refs = rowTaskRefs(row, tasks);
    return !refs.hasReference || hasCurrentTask(refs.uuids, tasks);
  });
}
