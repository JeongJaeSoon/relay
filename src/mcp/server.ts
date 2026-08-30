import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { client as httpClient, RelayDown } from "../cli/client.ts";
type C = { get(p: string): Promise<any>; post(p: string, b?: unknown, m?: string): Promise<any> };
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => ({ ...text(e instanceof RelayDown ? "relay 서버에 연결할 수 없습니다 — brew services start relay" : `relay 오류: ${String((e as Error)?.message ?? e)}`), isError: true });
/** Tool handlers must never throw out of the MCP process: a dead relay becomes an isError result, not a dead bridge. */
const guard = <A>(fn: (a: A) => Promise<ReturnType<typeof text>>) => async (a: A) => { try { return await fn(a); } catch (e) { return fail(e); } };
export function buildMcpServer(c: C) {
  const s = new McpServer({ name: "relay", version: process.env.RELAY_VERSION ?? "dev" });
  const resolve = async (to?: string) => { if (!to) return undefined; const snap = await c.get("/tasks?include=closed"); return snap.tasks.find((t: any) => t.display_id === to.toUpperCase() || t.uuid === to)?.uuid; };
  s.registerTool("relay_send", { description: "relay 오케스트레이터에 메시지를 보낸다(새 작업·후속 지시·질문 답변). to에 T-08 같은 태스크 ID를 주면 그 태스크에 직접 전달.", inputSchema: { text: z.string().min(1), to: z.string().optional() } },
    guard(async ({ text: t, to }) => { const reply = await resolve(to); if (to && !reply) return text(`태스크를 찾을 수 없음: ${to}`); const r = await c.post("/messages", { text: t, client_message_id: crypto.randomUUID(), source: "mcp", ...(reply ? { reply_to_task_id: reply } : {}) }); return text(`접수 ${r.message_id}${reply ? ` → ${to}` : ""}`); }));
  s.registerTool("relay_list", { description: "relay 태스크 목록(ID·상태·프로젝트·제목).", inputSchema: { include_closed: z.boolean().optional() } },
    guard(async ({ include_closed }) => { const snap = await c.get(include_closed ? "/tasks?include=closed" : "/tasks"); const pn = (id: string) => snap.projects.find((p: any) => p.id === id)?.name ?? id; const rows = snap.tasks.filter((t: any) => !t.parent_uuid).map((t: any) => `${t.display_id}  ${t.status.padEnd(13)}  ${pn(t.project_id)}  ${t.title}`); return text(rows.join("\n") || "(태스크 없음)"); }));
  s.registerTool("relay_status", { description: "relay 현재 상태 한 줄(실행 중/대기/사용량/kill switch).", inputSchema: {} },
    guard(async () => { const st = await c.get("/usage"); return text(`실행 중 ${st.running} · 대기 ${st.queued} · lease ${st.leases}/${st.max_concurrent_agents} · 오늘 사용량 ~${Math.round(st.today_tokens / 1000)}k tok(추정)${st.paused ? " · kill switch ON" : ""}`); }));
  return s;
}
export async function startMcp() { await buildMcpServer(httpClient()).connect(new StdioServerTransport()); }
