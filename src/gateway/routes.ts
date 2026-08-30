import { Hono } from "hono";
import type { AppContext } from "./server.ts";
import { snapshot } from "./snapshot.ts";
import { loadTask } from "../core/projections.ts";
export function apiRoutes(ctx: AppContext) {
  const api = new Hono();
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
