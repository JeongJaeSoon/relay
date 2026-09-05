import { isAsk, stripAsk } from "@shared/ask.ts";
import { readToken } from "./consts.ts";
const h = () => ({ authorization: `Bearer ${readToken()}`, "content-type": "application/json" });
export const api = {
  async get<T>(path: string): Promise<T> { const r = await fetch(`/api${path}`, { headers: h() }); if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json(); },
  async post<T = unknown>(path: string, body: unknown = {}, method = "POST"): Promise<T> { const r = await fetch(`/api${path}`, { method, headers: h(), body: JSON.stringify(body) }); if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json(); },
};
/** Ask mode: the toggle, a typed `?` and the task panel's button collapse into one request — the marker is stripped,
 *  the intent is declared, and `askTask` (a task uuid) scopes the question to that task without messaging it. */
type MessageOptions = { ask?: boolean; askTask?: string; replyTo?: string; clientMessageId?: string };
export const sendMessage = (text: string, opts: MessageOptions = {}) => {
  const q = !opts.replyTo && (opts.ask || !!opts.askTask || isAsk(text));
  return api.post<{ message_id: string }>("/messages", { text: q ? stripAsk(text) : text, client_message_id: opts.clientMessageId ?? crypto.randomUUID(),
    ...(q ? { ask: true } : {}), ...(q && opts.askTask ? { ask_task_id: opts.askTask } : {}), ...(opts.replyTo ? { reply_to_task_id: opts.replyTo } : {}) });
};
/** A retry after a lost HTTP acknowledgement must not create a second task. A changed draft starts a new request. */
export function createMessageSender() {
  let pending: { key: string; id: string; inFlight?: Promise<{ message_id: string }> } | null = null;
  return async (text: string, opts: MessageOptions = {}) => {
    const key = JSON.stringify([text, !!opts.ask, opts.askTask ?? null, opts.replyTo ?? null]);
    if (pending?.key === key && pending.inFlight) return pending.inFlight;
    if (!pending || pending.key !== key) pending = { key, id: crypto.randomUUID() };
    const attempt = pending;
    const request = sendMessage(text, { ...opts, clientMessageId: attempt.id });
    attempt.inFlight = request;
    try {
      const result = await request;
      if (pending === attempt) pending = null;
      return result;
    } finally {
      attempt.inFlight = undefined;   // a failed retry keeps its ID, but can be submitted again
    }
  };
}
export const answer = (uuid: string, text: string) => api.post(`/tasks/${uuid}/answer`, { text });
export const interrupt = (uuid: string) => api.post(`/tasks/${uuid}/interrupt`); export const close = (uuid: string) => api.post(`/tasks/${uuid}/close`); export const retry = (uuid: string) => api.post(`/tasks/${uuid}/retry`);
export const attachLease = (uuid: string) => api.post<{ command: string }>(`/tasks/${uuid}/attach-lease`, { by: "dashboard" }); export const releaseAttach = (uuid: string) => api.post(`/tasks/${uuid}/attach-lease`, {}, "DELETE");
export const pause = () => api.post("/pause"); export const resumeAll = () => api.post("/resume-all");
export const patchSettings = (p: { max_concurrent_agents: number }) => api.post("/settings", p, "PATCH");
export const registerProject = (p: { name: string; path: string; description: string; keywords: string[] }) => api.post<{ id: string }>("/projects", p); export const removeProject = (id: string) => api.post(`/projects/${id}`, {}, "DELETE");
/** The only call the dashboard can make about a session relay does not own. Everything else about it is read-only. */
export const stopForeign = (sessionId: string) => api.post(`/foreign/${encodeURIComponent(sessionId)}/stop`);
export const redispatch = (id: string) => api.post(`/messages/${id}/redispatch`); export const confirmCommand = (id: string) => api.post(`/commands/${id}/confirm`); export const retryCommand = (id: string) => api.post(`/commands/${id}/retry`);
export const taskDetail = (uuid: string) => api.get<{ task: unknown; events: unknown[]; commands: unknown[] }>(`/tasks/${uuid}`);

export const retryCleanup = (uuid: string) => api.post(`/tasks/${uuid}/retry-cleanup`);
