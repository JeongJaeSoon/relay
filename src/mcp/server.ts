import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { client as httpClient, RelayDown } from "../cli/client.ts";
type C = { get(p: string): Promise<any>; post(p: string, b?: unknown, m?: string): Promise<any> };
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => ({ ...text(e instanceof RelayDown ? "Cannot reach the relay server — brew services start relay" : `relay error: ${String((e as Error)?.message ?? e)}`), isError: true });
/** Tool handlers must never throw out of the MCP process: a dead relay becomes an isError result, not a dead bridge. */
const guard = <A>(fn: (a: A) => Promise<ReturnType<typeof text>>) => async (a: A) => { try { return await fn(a); } catch (e) { return fail(e); } };
export function buildMcpServer(c: C) {
  const s = new McpServer({ name: "relay", version: process.env.RELAY_VERSION ?? "dev" });
  const resolve = async (to?: string) => { if (!to) return undefined; const snap = await c.get("/tasks?include=closed"); return snap.tasks.find((t: any) => t.display_id === to.toUpperCase() || t.uuid === to)?.uuid; };
  // `ask` is how a non-typing source declares a question: the `?` prefix is a keyboard gesture and MCP never gets it.
  s.registerTool("relay_send", { description: "Send a message to the relay orchestrator (a new task, a follow-up, or an answer to a question). Pass a task id like T-08 in `to` to deliver it straight to that task. Set `ask` to ask a question about relay instead: it is answered in chat and never becomes a task.", inputSchema: { text: z.string().min(1), to: z.string().optional(), ask: z.boolean().optional() } },
    guard(async ({ text: t, to, ask }) => { const reply = await resolve(to); if (to && !reply) return text(`Task not found: ${to}`); const r = await c.post("/messages", { text: t, client_message_id: crypto.randomUUID(), source: "mcp", ...(ask ? { ask: true } : {}), ...(reply ? { reply_to_task_id: reply } : {}) }); return text(`Accepted ${r.message_id}${reply ? ` → ${to}` : ""}`); }));
  s.registerTool("relay_list", { description: "List relay tasks (id, status, project, title).", inputSchema: { include_closed: z.boolean().optional() } },
    guard(async ({ include_closed }) => { const snap = await c.get(include_closed ? "/tasks?include=closed" : "/tasks"); const pn = (id: string) => snap.projects.find((p: any) => p.id === id)?.name ?? id; const rows = snap.tasks.filter((t: any) => !t.parent_uuid).map((t: any) => `${t.display_id}  ${t.status.padEnd(13)}  ${pn(t.project_id)}  ${t.title}`); return text(rows.join("\n") || "(no tasks)"); }));
  s.registerTool("relay_status", { description: "One-line relay status: running, queued, usage, kill switch.", inputSchema: {} },
    guard(async () => { const st = await c.get("/usage"); return text(`Running ${st.running} · Queued ${st.queued} · lease ${st.leases}/${st.max_concurrent_agents} · today ~${Math.round(st.today_tokens / 1000)}k tok (est.)${st.paused ? " · kill switch ON" : ""}`); }));
  return s;
}
export async function startMcp() { await buildMcpServer(httpClient()).connect(new StdioServerTransport()); }
