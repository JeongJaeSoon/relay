// Minimal relay-shaped server: Hono + hono/bun websocket + bun:sqlite + embedded html + spawning `claude -p`.
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { Database } from "bun:sqlite";
import html from "./index.html" with { type: "file" };
const { upgradeWebSocket, websocket } = createBunWebSocket();
const db = new Database(":memory:"); db.run("create table t(seq integer primary key, v text)"); db.run("insert into t(v) values (?)", ["hi"]);
const app = new Hono();
app.get("/", async (c) => c.html(await Bun.file(html as unknown as string).text()));   // `with { type: "file" }` yields the embedded path at runtime
app.get("/api", (c) => c.json(db.query("select * from t").all()));
app.get("/claude", async (c) => { const p = Bun.spawn(["claude", "-p", "reply OK", "--tools", "", "--max-turns", "1", "--effort", "low", "--model", "claude-sonnet-5", "--output-format", "json"], { stdout: "pipe" }); return c.text(await new Response(p.stdout).text()); });
app.get("/ws", upgradeWebSocket(() => ({ onMessage(ev, ws) { ws.send("echo:" + ev.data); } })));
Bun.serve({ port: Number(process.argv[2] ?? 8801), hostname: "127.0.0.1", fetch: app.fetch, websocket });
