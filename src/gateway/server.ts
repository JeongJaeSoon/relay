import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import type { EventLog } from "../core/events.ts";
import { authMiddleware } from "./auth.ts";
import { apiRoutes } from "./routes.ts";
import { WsHub } from "./ws.ts";
type Services = Record<string, unknown>;   // replaced by the real `Services` from ../core/tasks.ts in Task 13

export interface AppContext { db: Database; cfg: Config; log: EventLog; hub: WsHub; tokens: { api: string; hook: string }; services: Services; dashboardHtml: () => Promise<string> }

export function buildApp(ctx: AppContext) {
  const { upgradeWebSocket, websocket } = createBunWebSocket();
  const app = new Hono();
  app.get("/", async (c) => {
    if (![`localhost:${ctx.cfg.port}`, `127.0.0.1:${ctx.cfg.port}`].includes(c.req.header("host") ?? "")) return c.text("forbidden host", 403);
    const html = (await ctx.dashboardHtml()).replace("<head>", `<head><meta name="relay-token" content="${ctx.tokens.api}">`);
    return c.html(html);
  });
  app.use("/api/*", authMiddleware(ctx.tokens, ctx.cfg.port));
  app.use("/ws", authMiddleware(ctx.tokens, ctx.cfg.port));
  app.route("/api", apiRoutes(ctx));
  app.get("/ws", upgradeWebSocket((c) => {
    const q = c.req.query("from_seq"); const fromSeq = q == null ? ctx.log.lastSeq() : Number(q);   // no from_seq = live only (first load takes the snapshot); reconnects pass their last seq
    return { onOpen(_e, ws) { ctx.hub.handleOpen(ws.raw as any, fromSeq); }, onClose(_e, ws) { ctx.hub.handleClose(ws.raw as any); } };
  }));
  return { app, websocket };
}
export function startServer(ctx: AppContext) {
  const { app, websocket } = buildApp(ctx);
  const server = Bun.serve({ port: ctx.cfg.port, hostname: "127.0.0.1", fetch: app.fetch, websocket });
  return { server, stop: () => server.stop(true) };
}
