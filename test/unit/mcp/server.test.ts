import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../../src/mcp/server.ts";
test("relay_send / relay_list / relay_status round trip", async () => {
  const calls: any[] = []; const fake = { post: async (p: string, b: unknown) => { calls.push([p, b]); return { message_id: "m9" }; }, get: async (p: string) => p.startsWith("/tasks") ? { tasks: [{ uuid: "u", display_id: "T-01", status: "running", title: "auth", project_id: "p", parent_uuid: null, started_at: Date.now() - 5000, ended_at: null }], projects: [{ id: "p", name: "myapp" }] } : { running: 1, queued: 0, leases: 1, today_tokens: 12000, paused: false, max_concurrent_agents: 10 } };
  const server = buildMcpServer(fake as any); const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a);
  const client = new Client({ name: "t", version: "0" }); await client.connect(b);
  const send = await client.callTool({ name: "relay_send", arguments: { text: "hi", to: "T-01" } }); expect((send.content as any)[0].text).toContain("m9"); expect(calls[0][1]).toMatchObject({ source: "mcp", reply_to_task_id: "u" });
  const ask = await client.callTool({ name: "relay_send", arguments: { text: "why is T-01 slow", ask: true } }); expect((ask.content as any)[0].text).toContain("m9");
  expect(calls[1][1]).toMatchObject({ source: "mcp", ask: true }); expect(calls[1][1].reply_to_task_id).toBeUndefined();
  await client.callTool({ name: "relay_send", arguments: { text: "? please fix the parser" } }); expect(calls[2][1].ask).toBeUndefined();   // no gesture over the wire: MCP declares or it is work
  const list = await client.callTool({ name: "relay_list", arguments: {} }); expect((list.content as any)[0].text).toContain("T-01");
  const st = await client.callTool({ name: "relay_status", arguments: {} }); expect((st.content as any)[0].text).toMatch(/Running 1/);
});
test("a dead relay becomes an isError result, the bridge stays alive", async () => {
  const { RelayDown } = await import("../../../src/cli/client.ts");
  const dead = { get: async () => { throw new RelayDown(); }, post: async () => { throw new RelayDown(); } };
  const server = buildMcpServer(dead as any); const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); const client = new Client({ name: "t", version: "0" }); await client.connect(b);
  const r = await client.callTool({ name: "relay_status", arguments: {} }); expect(r.isError).toBe(true); expect((r.content as any)[0].text).toContain("brew services start relay");
});
