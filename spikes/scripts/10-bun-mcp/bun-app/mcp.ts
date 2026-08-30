import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const server = new McpServer({ name: "relay-spike", version: "0.0.0" });
server.registerTool("relay_status", { description: "relay status", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "relay-spike: 1 running, 0 queued" }] }));
await server.connect(new StdioServerTransport());
