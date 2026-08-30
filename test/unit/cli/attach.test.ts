import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const seen: string[] = []; let srv: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "relay-att-")); process.env.RELAY_HOME = home; writeFileSync(join(home, "api-token"), "T"); writeFileSync(join(home, "config.toml"), "port = 8898\n");
  srv = Bun.serve({ port: 8898, hostname: "127.0.0.1", async fetch(req) { const p = new URL(req.url).pathname; seen.push(`${req.method} ${p}${new URL(req.url).search}`);
    if (p === "/api/tasks") return Response.json({ tasks: [{ uuid: "u1", display_id: "T-01", parent_uuid: null }], projects: [] });
    if (p.endsWith("/attach-lease") && req.method === "POST") { const b = await req.json(); seen.push(`by=${b.by}`); return Response.json({ command: "claude attach ab12" }); }
    return Response.json({ ok: true }); } });
});
afterAll(() => srv.stop(true));
test("attach acquires the lease with its pid, runs the command with the claude binary, releases after the child exits", async () => {
  process.env.RELAY_ATTACH_EXEC = "echo"; const { attach } = await import("../../../src/cli/attach.ts"); await attach(["T-01"]);
  expect(seen).toEqual(["GET /api/tasks?include=closed", "POST /api/tasks/u1/attach-lease", `by=cli:${process.pid}`, "DELETE /api/tasks/u1/attach-lease"]);
});
