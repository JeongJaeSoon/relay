import { readToken } from "./consts.ts";
const h = () => ({ authorization: `Bearer ${readToken()}`, "content-type": "application/json" });
export const api = {
  async get<T>(path: string): Promise<T> { const r = await fetch(`/api${path}`, { headers: h() }); if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json(); },
  async post<T = unknown>(path: string, body: unknown = {}, method = "POST"): Promise<T> { const r = await fetch(`/api${path}`, { method, headers: h(), body: JSON.stringify(body) }); if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json(); },
};
export const sendMessage = (text: string, replyTo?: string) => api.post<{ message_id: string }>("/messages", { text, client_message_id: crypto.randomUUID(), ...(replyTo ? { reply_to_task_id: replyTo } : {}) });
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
