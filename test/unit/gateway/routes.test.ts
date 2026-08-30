import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTestApp } from "../../helpers/app.ts";
describe("write routes", () => {
  test("POST /api/messages is 202, idempotent, validates reply targets before writing", async () => {
    const { req, db } = await buildTestApp();
    const a = await req("POST", "/api/messages", { text: "auth 리팩토링 해줘", client_message_id: "c1" }); expect(a.status).toBe(202); const { message_id } = (await a.json()) as any;
    const b = await req("POST", "/api/messages", { text: "auth 리팩토링 해줘", client_message_id: "c1" }); expect(((await b.json()) as any).message_id).toBe(message_id);
    expect(db.query("select count(*) c from messages where role='user'").get()).toEqual({ c: 1 });
    expect((await req("POST", "/api/messages", { text: "" })).status).toBe(400);
    expect((await req("POST", "/api/messages", { text: "x", reply_to_task_id: "nope" })).status).toBe(404);   // no FK explosion
  });
  test("task actions, settings, kill switch, attach lease", async () => {
    const { req, db, svc, seedTask } = await buildTestApp(); const uuid = seedTask("running");
    expect((await req("POST", `/api/tasks/${uuid}/answer`, { text: "x" })).status).toBe(409);               // not waiting
    expect((await req("POST", `/api/tasks/${uuid}/interrupt`)).status).toBe(200); expect((db.query("select status from tasks where uuid=?").get(uuid) as any).status).toBe("cancelled");
    expect((await req("POST", `/api/tasks/nope/close`)).status).toBe(404);
    const s = await req("PATCH", "/api/settings", { max_concurrent_agents: 3 }); expect(((await s.json()) as any).max_concurrent_agents).toBe(3);
    expect((await req("PATCH", "/api/settings", { max_concurrent_agents: 0 })).status).toBe(400);
    expect((await req("POST", "/api/pause")).status).toBe(200); expect(svc.paused()).toBe(true); expect((await req("POST", "/api/resume-all")).status).toBe(200); expect(svc.paused()).toBe(false);
    const u2 = seedTask("running"); const lease = await req("POST", `/api/tasks/${u2}/attach-lease`, { by: "test" }); expect(((await lease.json()) as any).command).toMatch(/^claude attach fake02$/);
    expect((await req("DELETE", `/api/tasks/${u2}/attach-lease`)).status).toBe(200);
  });
  test("projects register with git detection (directory .git) and remove", async () => {
    const { req } = await buildTestApp(); const dir = mkdtempSync(join(tmpdir(), "relay-proj-")); mkdirSync(join(dir, ".git"));
    const p = await req("POST", "/api/projects", { name: "x", path: dir, description: "d", keywords: ["a"] }); expect(p.status).toBe(201); const { id, is_git } = (await p.json()) as any; expect(is_git).toBe(true);
    const q = await req("POST", "/api/projects", { name: "y", path: tmpdir(), description: "", keywords: [] }); expect(((await q.json()) as any).is_git).toBe(false);
    expect((await req("DELETE", `/api/projects/${id}`)).status).toBe(200);
  });
  test("attached tasks refuse interrupt/close/retry (409); a late permission answer is 409; writes are 503 while recovering, reads stay open", async () => {
    const { req, db, seedTask } = await buildTestApp();
    const a = seedTask("running", { attach_state: "leased", attached_by: "cli:1" });
    for (const p of ["interrupt", "close"]) expect((await req("POST", `/api/tasks/${a}/${p}`)).status).toBe(409);
    const e = seedTask("error", { attach_state: "leased", attached_by: "cli:1" }); expect((await req("POST", `/api/tasks/${e}/retry`)).status).toBe(409);
    const w = seedTask("waiting_input", { question: { source: "permission", text: "?", options: ["Allow", "Deny"], asked_at: 1, permission_tool_use_id: "tu9" } });
    expect((await req("POST", `/api/tasks/${w}/answer`, { text: "Allow" })).status).toBe(409); expect((db.query("select status from tasks where uuid=?").get(w) as any).status).toBe("running");
    db.run("insert into meta(key,value) values('recovering','1') on conflict(key) do update set value='1'");
    expect((await req("POST", "/api/messages", { text: "x" })).status).toBe(503); expect((await req("GET", "/api/tasks")).status).toBe(200);
  });
});
