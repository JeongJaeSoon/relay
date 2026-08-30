import { describe, expect, test } from "bun:test";
import { authMiddleware, hookTokenFor } from "../../../src/gateway/auth.ts";
import { Hono } from "hono";

const app = new Hono();
app.use("/api/*", authMiddleware({ api: "API", hook: "HOOK" }));
app.get("/api/x", (c) => c.text("ok")); app.post("/api/x", (c) => c.text("ok")); app.post("/api/hooks", (c) => c.text("hook"));
const req = (path: string, init: RequestInit & { host?: string } = {}) => app.request(`http://localhost:8790${path}`, { ...init, headers: { host: init.host ?? "localhost:8790", ...(init.headers as any) } });

describe("auth", () => {
  test("rejects missing/wrong bearer", async () => {
    expect((await req("/api/x")).status).toBe(401);
    expect((await req("/api/x", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await req("/api/x", { headers: { authorization: "Bearer API" } })).status).toBe(200);
  });
  test("rejects foreign Host/Origin", async () => {
    expect((await req("/api/x", { host: "evil.com:8790", headers: { authorization: "Bearer API" } })).status).toBe(403);
    expect((await req("/api/x", { headers: { authorization: "Bearer API", origin: "https://evil.com" } })).status).toBe(403);
    expect((await req("/api/x", { headers: { authorization: "Bearer API", origin: "http://127.0.0.1:8790" } })).status).toBe(200);
  });
  test("write needs application/json", async () => {
    expect((await req("/api/x", { method: "POST", headers: { authorization: "Bearer API", "content-type": "text/plain" }, body: "x" })).status).toBe(415);
    expect((await req("/api/x", { method: "POST", headers: { authorization: "Bearer API", "content-type": "application/json" }, body: "{}" })).status).toBe(200);
  });
  test("per-task hook token only opens /api/hooks for its own task; the raw secret never works", async () => {
    const tok = hookTokenFor("HOOK", "u1");
    expect((await req("/api/hooks", { method: "POST", headers: { authorization: `Bearer ${tok}`, "x-relay-task": "u1", "content-type": "application/json" }, body: "{}" })).status).toBe(200);
    expect((await req("/api/hooks", { method: "POST", headers: { authorization: `Bearer ${tok}`, "x-relay-task": "u2", "content-type": "application/json" }, body: "{}" })).status).toBe(401);   // another task's header
    expect((await req("/api/hooks", { method: "POST", headers: { authorization: "Bearer HOOK", "x-relay-task": "u1", "content-type": "application/json" }, body: "{}" })).status).toBe(401);       // raw secret
    expect((await req("/api/x", { headers: { authorization: `Bearer ${tok}`, "x-relay-task": "u1" } })).status).toBe(401);
  });
});
