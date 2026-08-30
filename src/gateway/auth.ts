import type { MiddlewareHandler } from "hono";
import { createHmac } from "node:crypto";
/** Per-task hook token: a worker can only post hooks for its own task (header X-Relay-Task), so a prompt-injected worker cannot touch other tasks. */
export const hookTokenFor = (hookSecret: string, taskUuid: string) => createHmac("sha256", hookSecret).update(taskUuid).digest("hex");
export function authMiddleware(tokens: { api: string; hook: string }, port?: number): MiddlewareHandler {
  const hosts = new Set(port ? [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`] : []);
  const localHost = (h: string) => (port ? hosts.has(h) : /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h));   // exact configured port when known (no other localhost port may call us)
  return async (c, next) => {
    const host = c.req.header("host") ?? ""; if (!localHost(host)) return c.text("forbidden host", 403);
    const origin = c.req.header("origin"); if (origin) { try { if (!localHost(new URL(origin).host)) return c.text("forbidden origin", 403); } catch { return c.text("bad origin", 403); } }
    // browsers cannot set headers on WebSocket upgrades, so /ws (and only /ws) may carry the token as a query parameter
    const auth = c.req.header("authorization") ?? (c.req.path === "/ws" ? new URL(c.req.url).searchParams.get("token") : null) ?? "";
    const token = auth.replace(/^Bearer +/i, "");                                  // RFC 7235: the scheme is case-insensitive
    const isHooks = c.req.path === "/api/hooks"; const taskHeader = c.req.header("x-relay-task") ?? "";
    const hookOk = isHooks && taskHeader.length > 0 && timingSafe(token, hookTokenFor(tokens.hook, taskHeader));
    const ok = token.length > 0 && (timingSafe(token, tokens.api) || hookOk);
    if (!ok) return c.text("unauthorized", 401);
    const hasBody = c.req.raw.body !== null && c.req.header("content-length") !== "0";
    if (c.req.method !== "GET" && hasBody && !(c.req.header("content-type") ?? "").startsWith("application/json")) return c.text("json only", 415);   // simple-form CSRF guard; bodiless DELETE/POST pass
    await next();
  };
}
function timingSafe(a: string, b: string) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
