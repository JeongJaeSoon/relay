// src/serve.ts — assembles `relay serve`: files and tokens, db, event log, runner, services, HTTP, recovery, timers.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDirs, loadConfig, paths } from "./config.ts";
import { openDb, migrate, setMeta, getMeta } from "./db/db.ts";
import { EventLog } from "./core/events.ts";
import { WsHub } from "./gateway/ws.ts";
import { startServer, type AppContext } from "./gateway/server.ts";
import { PermitPool } from "./core/permits.ts";
import { Scheduler } from "./core/queue.ts";
import { Outbox } from "./lifecycle/outbox.ts";
import { TaskService } from "./core/tasks.ts";
import { Dispatcher, type RunClaude } from "./dispatcher/dispatcher.ts";
import { NativeSessionRunner } from "./runner/native.ts";
import type { AgentRunner } from "./runner/runner.ts";
import { buildSettingsJson, relayBin, workerEnv } from "./runner/settings.ts";
import { loadCapabilities } from "./runner/capabilities.ts";
import { loadPeerFixture, PeerServer } from "./runner/peer.ts";
import { PermissionPolicy } from "./guard/permission.ts";
import { Spool } from "./hooks/spool.ts";
import { recover } from "./lifecycle/recovery.ts";
import { IdleReaper } from "./lifecycle/idle.ts";
import { UsageGuard } from "./lifecycle/usage.ts";
import { Watchdog } from "./lifecycle/watchdog.ts";
import { log } from "./log.ts";
import { hookTokenFor } from "./gateway/auth.ts";
import type { PendingPermission } from "./hooks/ingest.ts";
import dashboardHtml from "../web/dist/index.html" with { type: "file" };   // replaced by plan 03's build; a placeholder until then

const token = (file: string) => { if (!existsSync(file)) writeFileSync(file, Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"), { mode: 0o600 }); return readFileSync(file, "utf8").trim(); };
export const VERSION = process.env.RELAY_VERSION ?? "dev";   // `bun build --define process.env.RELAY_VERSION="x.y.z"` stamps it into the binary
export async function serve(opts: { runner?: AgentRunner; runClaude?: RunClaude } = {}) {
  ensureDirs(); const cfg = loadConfig();
  if (cfg.path_prepend.length) process.env.PATH = [...cfg.path_prepend, process.env.PATH ?? ""].join(":");   // launchd PATH lacks nvm/npm dirs; `claude` needs `node` for npm installs
  if (process.env.RELAY_SERVICE && existsSync(paths.serviceFailed) && readFileSync(paths.serviceFailed, "utf8").trim() === VERSION) {
    console.error("relay: 이전 기동이 실패했습니다 — `relay doctor` 후 `brew services restart relay`"); process.exit(0);   // KeepAlive successful_exit:false → exit 0 stays down
  }
  try { return await boot(cfg, opts); } catch (e) { log.error("boot failed", { e: String(e) }); if (process.env.RELAY_SERVICE) { writeFileSync(paths.serviceFailed, VERSION); process.exit(78); } throw e; }
}
async function boot(cfg: ReturnType<typeof loadConfig>, opts: { runner?: AgentRunner; runClaude?: RunClaude }) {
  if (process.env.ANTHROPIC_API_KEY) { log.warn("ANTHROPIC_API_KEY is set — removing it from the relay process environment (API billing guard)"); delete process.env.ANTHROPIC_API_KEY; }
  const tokens = { api: token(paths.apiToken), hook: token(paths.hookToken) }; const oauth = existsSync(paths.oauthToken) ? readFileSync(paths.oauthToken, "utf8").trim() : null;
  for (const f of [paths.apiToken, paths.hookToken, paths.oauthToken, paths.config, paths.db]) { try { if (existsSync(f)) chmodSync(f, 0o600); } catch {} }   // re-tighten modes every start (B8)
  for (const dir of [paths.home, paths.spool, paths.logDir]) { try { chmodSync(dir, 0o700); } catch {} }
  const db = openDb(paths.db); const mig = migrate(db); log.info("db ready", mig);
  setMeta(db, "recovering", "1");                                            // before the HTTP server opens: every hook buffers until reconcile is done
  let hub!: WsHub; const evlog = new EventLog(db, (f) => hub.broadcast(f), cfg); hub = new WsHub(() => evlog, cfg, db);
  const caps = loadCapabilities(); setMeta(db, "delivery_method", caps.delivery); setMeta(db, "version", VERSION); setMeta(db, "log_dir", paths.logDir); setMeta(db, "oauth_fallback", oauth ? "1" : "0");
  if (!getMeta(db, "relay_instance_id")) setMeta(db, "relay_instance_id", crypto.randomUUID()); const instanceId = () => getMeta(db, "relay_instance_id")!;
  const maxAgents = () => Number(getMeta(db, "max_concurrent_agents") ?? cfg.max_concurrent_agents);
  const baseEnv = () => workerEnv({ taskUuid: "", port: cfg.port, hookToken: "", oauthToken: oauth, maxAgents: maxAgents() });
  let peer: PeerServer | null = null; const fixture = loadPeerFixture();
  if (caps.delivery === "socket" && fixture && !opts.runner) { peer = new PeerServer("relay", crypto.randomUUID(), (frame) => log.info("peer message", { frame })); await peer.start(); }
  const runner = opts.runner ?? new NativeSessionRunner(baseEnv, { claudeBin: cfg.claude_bin, peer: peer && fixture ? { fixture, socketPath: peer.socketPath, sessionId: "relay" } : undefined });
  const permits = new PermitPool(db, evlog, maxAgents, { subagentPerTask: cfg.pool.subagent_parallel_per_task });
  let svc!: TaskService; const pendingPermissions = new Map<string, PendingPermission>();
  const bin = relayBin();
  const outbox = new Outbox(db, evlog, runner, { delivery: () => caps.delivery, isPaused: () => svc.paused(), settingsJson: (t, gen) => buildSettingsJson({ port: cfg.port, allowPush: cfg.worker.allow_push, maxAgents: maxAgents(), bin, taskUuid: t.uuid, hookToken: hookTokenFor(tokens.hook, t.uuid), gen, home: paths.home }),   // literal per-task values: a --bg worker inherits no environment
    env: (t, gen) => workerEnv({ taskUuid: t.uuid, port: cfg.port, hookToken: hookTokenFor(tokens.hook, t.uuid), oauthToken: oauth, maxAgents: maxAgents(), gen }),   // per-task token + generation nonce
    socketPathFor: (r) => join(existsSync("/tmp/cc-socks") ? "/tmp/cc-socks" : `/tmp/cc-socks-${process.getuid?.() ?? 501}`, `${r.pid}.sock`), instanceId });
  const scheduler = new Scheduler(db, evlog, permits, (t) => svc.startSlot(t), () => svc.paused());
  svc = new TaskService({ db, log: evlog, cfg, permits, scheduler, outbox, projectNameOf: (id) => (db.query("select name from projects where id=?").get(id) as any)?.name ?? id, pendingPermissions });
  svc.ingestDeps.policy = new PermissionPolicy(cfg.worker.allow_push);
  const dispatcher = new Dispatcher(db, evlog, cfg, { runClaude: opts.runClaude, onDecision: (m, d, p) => svc.applyDecision(m, d, p), onNeedsConfirm: (m, d, r) => svc.needsConfirm(m, d, r), isPaused: () => svc.paused() });
  const usage = new UsageGuard(db, evlog, cfg, svc, permits); const idle = new IdleReaper(db, evlog, cfg, outbox, svc); const watchdog = new Watchdog(db, evlog, runner, svc, permits);
  const prevStop = svc.ingestDeps.onStop; svc.ingestDeps.onStop = (t, b) => { usage.sampleTranscript(t, String(b.transcript_path ?? "")); prevStop(t, b); };   // installed before recover(): replayed Stops are sampled too
  svc.onToolUse = (t, promptId) => { if (usage.countToolCall(t.uuid, promptId)) { log.warn("tool-call cap hit — interrupting", { task: t.uuid }); svc.interrupt(t.uuid); } };
  svc.onNudge = () => { watchdog.tick().catch((e) => log.warn("watchdog", { e: String(e) })); };
  const ctx: AppContext = { db, cfg, log: evlog, hub, tokens, services: { ingestDeps: svc.ingestDeps, tasks: svc, outbox, scheduler, dispatcher, permits, pendingPermissions }, dashboardHtml: () => Bun.file(dashboardHtml as unknown as string).text() };
  const http = startServer(ctx); log.info("listening", { port: cfg.port });
  const spool = new Spool(paths.spool, () => svc.ingestDeps);
  await recover({ db, log: evlog, runner, permits, outbox, dispatcher, scheduler, tasks: svc, spool, maxAgents, instanceId });
  const timers = [setInterval(() => idle.tick(), 60_000), setInterval(() => usage.tick(), 60_000), setInterval(() => watchdog.tick().catch((e) => log.warn("watchdog", { e: String(e) })), 5_000), setInterval(() => spool.drain().catch(() => {}), 30_000), setInterval(() => spool.sweep(7), 3600_000)];
  const stop = () => { timers.forEach(clearInterval); for (const p of pendingPermissions.values()) p.resolve("deny"); http.stop(); peer?.stop(); db.close(); };   // never leave a worker waiting on a dead relay
  process.on("SIGTERM", () => { stop(); process.exit(0); }); process.on("SIGINT", () => { stop(); process.exit(0); });
  return { ctx, stop };
}
