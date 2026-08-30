import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const calls: any[] = []; let srv: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "relay-cli-")); process.env.RELAY_HOME = home; writeFileSync(join(home, "api-token"), "TOK"); writeFileSync(join(home, "config.toml"), "port = 8899\n");   // per file: own home + own port (shared module cache)
  srv = Bun.serve({ port: 8899, hostname: "127.0.0.1", async fetch(req) { const u = new URL(req.url); calls.push([req.method, u.pathname, req.headers.get("authorization"), req.method === "POST" ? await req.json() : null]);
    if (u.pathname === "/api/messages") return Response.json({ message_id: "m1" }, { status: 202 });
    if (u.pathname === "/api/tasks") return Response.json({ as_of_seq: 1, tasks: [{ uuid: "u1", display_id: "T-01", status: "running", title: "인증 리팩토링", project_id: "p", started_at: Date.now() - 65_000, ended_at: null, short_id: "ab12", parent_uuid: null }], projects: [{ id: "p", name: "myapp" }], state: {}, messages: [] });
    return Response.json({ ok: true }); } });
});
afterAll(() => srv.stop(true));
async function capture(fn: () => Promise<void>) { const w = process.stdout.write.bind(process.stdout); let out = ""; (process.stdout as any).write = (s: string) => { out += s; return true; }; try { await fn(); } finally { (process.stdout as any).write = w; } return out; }
describe("relay cli", () => {
  test("send posts with bearer and client_message_id; --to sets reply_to_task_id", async () => {
    const { runCli } = await import("../../../src/cli/index.ts");
    const out = await capture(() => runCli("send", ["hello", "--to", "u1"]));
    expect(out).toContain("Accepted m1"); const c = calls.find((x) => x[1] === "/api/messages"); expect(c[2]).toBe("Bearer TOK"); expect(c[3].reply_to_task_id).toBe("u1"); expect(c[3].client_message_id).toMatch(/\S/);
  });
  test("ls prints a table with display id, status, project and elapsed; Korean titles keep the columns aligned", async () => {
    const { runCli } = await import("../../../src/cli/index.ts"); const out = await capture(() => runCli("ls", []));
    expect(out).toContain("T-01"); expect(out).toContain("running"); expect(out).toContain("myapp"); expect(out).toMatch(/1m/);
    const [head, row] = out.split("\n"); expect(Bun.stringWidth(head.split("Elapsed")[0])).toBe(Bun.stringWidth(row.split("1m")[0]));   // the Elapsed column starts at the same visual offset
  });
  test("pause/resume-all hit the endpoints", async () => { const { runCli } = await import("../../../src/cli/index.ts"); await capture(() => runCli("pause", [])); await capture(() => runCli("resume-all", [])); expect(calls.some((c) => c[1] === "/api/pause")).toBe(true); expect(calls.some((c) => c[1] === "/api/resume-all")).toBe(true); });
  test("a dead server throws RelayDown instead of exiting the process", async () => {
    const { client, RelayDown } = await import("../../../src/cli/client.ts"); process.env.RELAY_HOME = mkdtempSync(join(tmpdir(), "relay-cli-dead-")); writeFileSync(join(process.env.RELAY_HOME, "config.toml"), "port = 8897\n");
    await expect(client().get("/tasks")).rejects.toBeInstanceOf(RelayDown);
  });
});
