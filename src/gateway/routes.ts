import { Hono } from "hono";
import type { AppContext } from "./server.ts";
import { snapshot } from "./snapshot.ts";
import { loadTask } from "../core/projections.ts";
import { ingestHook, type IngestDeps } from "../hooks/ingest.ts";
export function apiRoutes(ctx: AppContext) {
  const api = new Hono();
  // ---- worker hook stream (Task 8) ----
  api.post("/hooks", async (c) => {
    const deps = ctx.services.ingestDeps as IngestDeps | undefined;
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
  return api;
}
