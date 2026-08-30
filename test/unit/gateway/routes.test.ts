import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTestApp, decide } from "../../helpers/app.ts";
import { FOREIGN_GRACE_MS } from "../../../src/lifecycle/foreign.ts";
import { setNow } from "../../../src/core/clock.ts";
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
  test("a project root must be a git repository", async () => {
    // A worktree checkout has `.git` as a file, a clone as a directory; both are repositories.
    const { req } = await buildTestApp(); const dir = mkdtempSync(join(tmpdir(), "relay-proj-")); mkdirSync(join(dir, ".git"));
    const p = await req("POST", "/api/projects", { name: "x", path: dir, description: "d", keywords: ["a"] }); expect(p.status).toBe(201);
    const { id, is_git } = (await p.json()) as any; expect(is_git).toBe(true);

    const plain = mkdtempSync(join(tmpdir(), "relay-plain-"));                 // a directory of repositories is not itself one
    const q = await req("POST", "/api/projects", { name: "y", path: plain, description: "", keywords: [] });
    expect(q.status).toBe(400); expect(await q.text()).toContain("not a git repository");
    const gone = await req("POST", "/api/projects", { name: "z", path: join(plain, "nope"), description: "", keywords: [] });
    expect(gone.status).toBe(400); expect(await gone.text()).toContain("no such path");

    expect((await req("DELETE", `/api/projects/${id}`)).status).toBe(200);
  });
  test("redispatch refuses a message whose dispatch already landed — a second decision would mint a second task", async () => {
    const s = await buildTestApp(decide({ action: "new_task", project: "myapp", title: "t", size: "small", prompt: "p", confidence: "high" }));
    const r = await s.req("POST", "/api/messages", { text: "auth 리팩토링 해줘", client_message_id: "c1" }); const { message_id } = (await r.json()) as any;
    await s.settle(120);
    expect((s.db.query("select dispatch_state from messages where id=?").get(message_id) as any).dispatch_state).toBe("dispatched");
    expect(s.db.query("select count(*) c from tasks").get()).toEqual({ c: 1 });
    const again = await s.req("POST", `/api/messages/${message_id}/redispatch`);
    expect(again.status).toBe(409); expect(await again.text()).toContain("dispatched");
    await s.settle(120);
    expect(s.db.query("select count(*) c from tasks").get()).toEqual({ c: 1 });                              // no second task
    expect((s.db.query("select dispatch_state from messages where id=?").get(message_id) as any).dispatch_state).toBe("dispatched");
  });
  test("redispatch accepts only the states where no decision landed (pending/failed/needs_confirm)", async () => {
    const s = await buildTestApp();
    const seed = (id: string, dispatch_state: string) => s.log.emit({ type: "message.received", payload: { id, role: "user", source: "user", client_message_id: id, dispatch_state, text: "x", task_uuid: null, reply_to_task_uuid: null, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: 1 } });
    for (const st of ["pending", "failed", "needs_confirm"]) { seed(`ok-${st}`, st); expect((await s.req("POST", `/api/messages/ok-${st}/redispatch`)).status).toBe(200); }
    for (const st of ["deciding", "dispatched", "fastpath", "direct"]) {
      seed(`no-${st}`, st); const res = await s.req("POST", `/api/messages/no-${st}/redispatch`);
      expect(res.status).toBe(409); expect(await res.text()).toContain(st);
      expect((s.db.query("select dispatch_state from messages where id=?").get(`no-${st}`) as any).dispatch_state).toBe(st);   // untouched
    }
    expect((await s.req("POST", "/api/messages/nope/redispatch")).status).toBe(404);
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
  test("the snapshot carries the sessions relay only watches, and stopping one is refused unless it is still foreign", async () => {
    const { req, runner, foreign, seedTask } = await buildTestApp(); const t0 = Date.now(); setNow(() => t0);
    try {
      seedTask("running");                                                                    // relay's own: sid1 / fake01
      expect(((await (await req("GET", "/api/tasks")).json()) as any).foreign).toEqual([]);    // the common case is none
      runner.rows.set("out1", { short_id: "out1", session_id: "outside-1", name: "scratch", cwd: "/no/such/dir", pid: 77, alive: true, busy: false, waiting_for: null, raw: {} });
      foreign.refresh(await runner.list(true));                                                // first sighting: held back for the grace period
      setNow(() => t0 + FOREIGN_GRACE_MS); foreign.refresh(await runner.list(true));
      expect((((await (await req("GET", "/api/tasks")).json()) as any).foreign as any[]).map((f) => f.session_id)).toEqual(["outside-1"]);
      expect((await req("POST", "/api/foreign/sid1/stop")).status).toBe(404);                  // a relay worker is not stoppable through this route
      expect((await req("POST", "/api/foreign/outside-1/stop")).status).toBe(200);
      expect(runner.calls.filter((c) => c.kind === "stop")).toEqual([{ kind: "stop", args: "out1" }]);
    } finally { setNow(null); }
  });
});
