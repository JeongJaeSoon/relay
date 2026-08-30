import { Hono } from "hono";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Task } from "@shared/types.ts";
import type { AppContext } from "./server.ts";
import { snapshot } from "./snapshot.ts";
import { loadTask } from "../core/projections.ts";
import { now } from "../core/clock.ts";
import { ulid } from "../core/ids.ts";
import { getMeta } from "../db/db.ts";
import { ingestHook } from "../hooks/ingest.ts";
export function apiRoutes(ctx: AppContext) {
  const api = new Hono();
  // ---- worker hook stream (Task 8) ----
  api.post("/hooks", async (c) => {
    const deps = ctx.services.ingestDeps;
    if (!deps) return c.json({ error: "not ready" }, 503);
    const r = ingestHook(await c.req.json(), { "x-relay-task": c.req.header("x-relay-task"), "x-relay-gen": c.req.header("x-relay-gen") }, deps);
    // a held PermissionRequest keeps the HTTP response open until the user answers in the dashboard (hook timeout 900s)
    if ("wait" in r) return c.json((await r.wait) as any, 200);
    return c.json(r.json as any, r.status as any);
  });
  // ---- read (Task 4) ----
  api.get("/tasks", (c) => c.json(snapshot(ctx.db, ctx.cfg, c.req.query("include") === "closed")));
  api.get("/tasks/:id", (c) => {
    const t = loadTask(ctx.db, c.req.param("id")); if (!t) return c.json({ error: "not found" }, 404);
    const events = ctx.db.query("select * from events where task_uuid=? order by seq desc limit 200").all(t.uuid).reverse().map((r: any) => ({ ...r, payload: JSON.parse(r.payload_json), truncated: !!r.truncated }));
    const commands = ctx.db.query("select * from commands where task_uuid=? order by rowid").all(t.uuid).map((r: any) => ({ ...r, payload: JSON.parse(r.payload_json) }));
    return c.json({ task: t, events, commands });
  });
  api.get("/projects", (c) => c.json(snapshot(ctx.db, ctx.cfg).projects));
  api.get("/usage", (c) => c.json(snapshot(ctx.db, ctx.cfg).state));
  // ---- write (Task 13) ----
  const S = ctx.services; const bad = (c: any, msg: string, code = 400) => c.json({ error: msg }, code);
  const withTask = (c: any) => loadTask(ctx.db, c.req.param("id"));
  api.use("*", async (c, next) => { if (c.req.method !== "GET" && c.req.path !== "/api/hooks" && getMeta(ctx.db, "recovering") === "1") return c.json({ error: "recovering — 잠시 후 다시 시도" }, 503); await next(); });   // writes wait for reconcile; hooks buffer durably
  const attached = (c: any, t: Task) => (t.attach_state !== "none" ? bad(c, `터미널에 attach 중(${t.attached_by}) — 먼저 detach 하세요`, 409) : null);
  api.post("/messages", async (c) => {
    const b = z.object({ text: z.string().trim().min(1).max(20_000), client_message_id: z.string().max(128).optional(), reply_to_task_id: z.string().optional(), source: z.enum(["user", "cli", "mcp", "github", "slack", "cron"]).default("user") }).safeParse(await c.req.json());
    if (!b.success) return bad(c, "invalid body");
    const cid = b.data.client_message_id ?? ulid();
    const dup = ctx.db.query("select id from messages where client_message_id=?").get(cid) as any; if (dup) return c.json({ message_id: dup.id }, 202);
    const reply = b.data.reply_to_task_id ?? null;
    if (reply && !loadTask(ctx.db, reply)) return bad(c, "unknown task", 404);                 // validate before emit: messages.task_uuid is a foreign key
    const id = ulid();
    ctx.log.emit({ type: "message.received", task_uuid: reply, payload: { id, role: "user", source: b.data.source, client_message_id: cid, dispatch_state: reply ? "direct" : "pending", text: b.data.text, task_uuid: reply, reply_to_task_uuid: reply, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: now() } });
    if (reply) S.tasks.answer(reply, b.data.text, id); else S.dispatcher.enqueue(id);
    return c.json({ message_id: id }, 202);
  });
  api.post("/messages/:id/redispatch", (c) => { const m = ctx.db.query("select * from messages where id=?").get(c.req.param("id")); if (!m) return bad(c, "not found", 404); ctx.log.emit({ type: "dispatch.requeued", payload: { message_id: c.req.param("id"), patch: { dispatch_state: "pending", dispatch_error: null } } }); S.dispatcher.enqueue(c.req.param("id")); return c.json({ ok: true }); });
  api.post("/tasks/:id/answer", async (c) => { const t = withTask(c); if (!t) return bad(c, "not found", 404); if (t.status !== "waiting_input") return bad(c, `not waiting for input (${t.status}) — use POST /api/messages`, 409); const b = z.object({ text: z.string().min(1) }).safeParse(await c.req.json()); if (!b.success) return bad(c, "text required"); if (!S.tasks.answer(t.uuid, b.data.text, null)) return bad(c, "승인 요청이 이미 만료됨(자동 거부) — 워커가 계속 진행 중", 409); return c.json({ ok: true }); });
  api.post("/tasks/:id/interrupt", (c) => { const t = withTask(c); if (!t) return bad(c, "not found", 404); if (["closed", "cancelled"].includes(t.status)) return bad(c, `cannot interrupt in ${t.status}`, 409); const a = attached(c, t); if (a) return a; S.tasks.interrupt(t.uuid); return c.json({ ok: true }); });
  api.post("/tasks/:id/close", (c) => { const t = withTask(c); if (!t) return bad(c, "not found", 404); const a = attached(c, t); if (a) return a; S.tasks.close(t.uuid); return c.json({ ok: true }); });
  api.post("/tasks/:id/retry", (c) => { const t = withTask(c); if (!t) return bad(c, "not found", 404); if (!["error", "cancelled", "needs_review"].includes(t.status)) return bad(c, `cannot retry in ${t.status}`, 409); const a = attached(c, t); if (a) return a; S.tasks.retry(t.uuid); return c.json({ ok: true }); });
  api.post("/tasks/:id/attach-lease", async (c) => { const t = withTask(c); if (!t) return bad(c, "not found", 404); const b = z.object({ by: z.string().default("cli") }).parse(await c.req.json().catch(() => ({}))); return c.json(S.tasks.attachLease(t.uuid, b.by)); });
  api.delete("/tasks/:id/attach-lease", (c) => { const t = withTask(c); if (!t) return bad(c, "not found", 404); S.tasks.releaseAttach(t.uuid); return c.json({ ok: true }); });
  api.post("/projects", async (c) => {
    const b = z.object({ name: z.string().min(1), path: z.string().min(1), description: z.string().default(""), keywords: z.array(z.string()).default([]), base_ref: z.enum(["fresh", "head"]).default("fresh") }).safeParse(await c.req.json()); if (!b.success) return bad(c, "invalid project");
    const id = ulid(); const is_git = existsSync(join(b.data.path, ".git"));   // directory (repo) or file (worktree checkout); Bun.file().exists() is false for directories
    ctx.log.emit({ type: "project.registered", payload: { id, ...b.data, is_git, created_at: now() } }); return c.json({ id, is_git }, 201);
  });
  api.delete("/projects/:id", (c) => { ctx.log.emit({ type: "project.removed", payload: { id: c.req.param("id") } }); return c.json({ ok: true }); });
  api.patch("/settings", async (c) => { const b = z.object({ max_concurrent_agents: z.number().int().min(1).optional() }).safeParse(await c.req.json()); if (!b.success) return bad(c, "invalid settings"); ctx.log.emit({ type: "settings.changed", payload: b.data }); void S.scheduler.pump(); return c.json(snapshot(ctx.db, ctx.cfg).state); });
  api.post("/pause", (c) => { S.tasks.pause(); return c.json({ ok: true }); });
  api.post("/resume-all", (c) => { S.tasks.resumeAll(); S.dispatcher.drainPending(); return c.json({ ok: true }); });
  api.post("/commands/:id/confirm", (c) => { S.outbox.confirm(c.req.param("id")); return c.json({ ok: true }); });
  api.post("/commands/:id/retry", (c) => { S.outbox.retry(c.req.param("id")); return c.json({ ok: true }); });
  return api;
}
