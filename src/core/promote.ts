import type { Message, Task } from "@shared/types.ts";
import { now } from "./clock.ts";
import { ulid } from "./ids.ts";

export type MessageInput = Omit<Message, "dispatch_json" | "dispatch_error" | "chain_prev_id"> & { dispatch_json: null; dispatch_error: null; chain_prev_id: null };
const base = (task: Task | null, role: Message["role"], text: string): MessageInput => ({ id: ulid(), role, source: "user", client_message_id: null, dispatch_state: "direct", text, task_uuid: task?.uuid ?? null, reply_to_task_uuid: null, ask: false, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: now() });

/** Only these five kinds reach the chat timeline (§5.1). Everything else stays on the dashboard. */
export function chatFor(kind: "started" | "completed" | "question" | "blocked" | "error" | "cancelled", task: Task, text: string, projectName = ""): MessageInput {
  switch (kind) {
    case "started": return base(task, "system", `▶ [${projectName || task.project_id}] ${task.title} started (${task.display_id})`);
    case "completed": return base(task, "worker_summary", `✔ ${task.display_id} ${task.title} — ${text}`);
    case "question": return base(task, "question", `❓ ${task.display_id} ${task.title}: ${text}`);
    case "blocked": return base(task, "question", `⛔ ${task.display_id} ${task.title}: ${text}`);
    case "error": return base(task, "error", `✖ ${task.display_id} ${task.title} — ${text}`);
    case "cancelled": return base(task, "system", `■ ${task.display_id} ${task.title} cancelled`);
  }
}
