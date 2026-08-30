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
import { currentCliVersion, driftWarns, loadCapabilities, showVersion, versionDrift, versionOk } from "./runner/capabilities.ts";
import { frameText, loadPeerFixture, markersIn, PeerServer, sessionIdForSocket, socketPathForSession } from "./runner/peer.ts";
import { PermissionPolicy } from "./guard/permission.ts";
import { Spool } from "./hooks/spool.ts";
import { recover } from "./lifecycle/recovery.ts";
import { IdleReaper } from "./lifecycle/idle.ts";
import { UsageGuard } from "./lifecycle/usage.ts";
import { Watchdog } from "./lifecycle/watchdog.ts";
import { ForeignSessions } from "./lifecycle/foreign.ts";
import { sweep } from "./lifecycle/retention.ts";
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
    console.error("relay: the previous start failed — run `relay doctor`, then `brew services restart relay`"); process.exit(0);   // KeepAlive successful_exit:false → exit 0 stays down
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
  let hub!: WsHub; let foreign: ForeignSessions | undefined;
  const evlog = new EventLog(db, (f) => hub.broadcast(f), cfg); hub = new WsHub(() => evlog, cfg, db, () => foreign?.list() ?? []);
  const caps = loadCapabilities(); setMeta(db, "delivery_method", caps.delivery); setMeta(db, "version", VERSION); setMeta(db, "log_dir", paths.logDir); setMeta(db, "oauth_fallback", oauth ? "1" : "0");
  // Everything relay knows about the CLI was measured once, into capabilities.json. A `claude update` since then can
  // turn into quiet misbehaviour, so say so — but never block the boot and never re-probe: the probe spawns a real
  // background session and spends subscription usage, which is the user's call, not a service restart's.
  const cliVersion = await currentCliVersion(cfg.claude_bin); const drift = versionDrift(caps.cli_version, cliVersion);
  setMeta(db, "cli_drift", driftWarns(drift) ? `${showVersion(caps.cli_version)} → ${showVersion(cliVersion)}` : "");
  if (driftWarns(drift)) log.warn("claude CLI version drift — capabilities.json may no longer describe this CLI; run `relay doctor --probe` to re-measure", { probed: caps.cli_version, current: cliVersion, drift });
  // Independent of the drift check above: that one asks whether this is the CLI we measured, this one whether the CLI
  // is supported at all. A downgrade below the floor is a `patch` drift the check above deliberately stays quiet
  // about. Warn only — refusing to start under launchd means exit 0 into the service-failed path, which is
  // indistinguishable from a crashed service; `relay doctor` and `relay setup` already refuse where a human is watching.
  if (!versionOk(cliVersion)) log.warn(`claude CLI ${cliVersion || "version unreadable"} — relay requires 2.1.251 or newer; workers can fail at spawn on flags this build may not have (--bg, --agent, --settings, --json-schema). Run \`claude update\`.`, { current: cliVersion, floor: "2.1.251" });
  if (!getMeta(db, "relay_instance_id")) setMeta(db, "relay_instance_id", crypto.randomUUID()); const instanceId = () => getMeta(db, "relay_instance_id")!;
  const maxAgents = () => Number(getMeta(db, "max_concurrent_agents") ?? cfg.max_concurrent_agents);
  const baseEnv = () => workerEnv({ taskUuid: "", port: cfg.port, hookToken: "", oauthToken: oauth, maxAgents: maxAgents() });
  let peer: PeerServer | null = null; const fixture = loadPeerFixture();
  // relay must LISTEN on the socket it advertises as `from`, or the workers' replies land in whatever other peer is
  // registered (exactly the bug that produced the first, wrong delivery matrix in Phase 0 ②).
  let onPeerFrame: (frame: any) => void = (frame) => log.warn("peer frame arrived before the services were wired", { frame });
  if (caps.delivery === "socket" && fixture && !opts.runner) { peer = new PeerServer("relay", crypto.randomUUID(), (frame) => onPeerFrame(frame)); await peer.start(); }
  const runner = opts.runner ?? new NativeSessionRunner(baseEnv, { claudeBin: cfg.claude_bin, peer: peer && fixture ? { fixture, socketPath: peer.socketPath, sessionId: "relay" } : undefined });
  const permits = new PermitPool(db, evlog, maxAgents, { subagentPerTask: cfg.pool.subagent_parallel_per_task });
  let svc!: TaskService; const pendingPermissions = new Map<string, PendingPermission>();
  const bin = relayBin();
  const outbox = new Outbox(db, evlog, runner, { delivery: () => caps.delivery, isPaused: () => svc.paused(), settingsJson: (t, gen) => buildSettingsJson({ port: cfg.port, allowPush: cfg.worker.allow_push, maxAgents: maxAgents(), bin, taskUuid: t.uuid, hookToken: hookTokenFor(tokens.hook, t.uuid), gen, home: paths.home }),   // literal per-task values: a --bg worker inherits no environment
    env: (t, gen) => workerEnv({ taskUuid: t.uuid, port: cfg.port, hookToken: hookTokenFor(tokens.hook, t.uuid), oauthToken: oauth, maxAgents: maxAgents(), gen }),   // per-task token + generation nonce
    // background roster rows carry no pid, so the inbox socket comes from the session registry (roadmap C3)
    socketPathFor: (r) => socketPathForSession(r.session_id) ?? join(existsSync("/tmp/cc-socks") ? "/tmp/cc-socks" : `/tmp/cc-socks-${process.getuid?.() ?? 501}`, `${r.pid}.sock`), instanceId });
  const scheduler = new Scheduler(db, evlog, permits, (t) => svc.startSlot(t), () => svc.paused());
  svc = new TaskService({ db, log: evlog, cfg, permits, scheduler, outbox, projectNameOf: (id) => (db.query("select name from projects where id=?").get(id) as any)?.name ?? id, pendingPermissions });
  svc.ingestDeps.policy = new PermissionPolicy(cfg.worker.allow_push);
  const dispatcher = new Dispatcher(db, evlog, cfg, { runClaude: opts.runClaude, onDecision: (m, d, p) => svc.applyDecision(m, d, p), onNeedsConfirm: (m, d, r) => svc.needsConfirm(m, d, r), isPaused: () => svc.paused() });
  foreign = new ForeignSessions(db, runner, (list) => hub.broadcastForeign(list));
  const usage = new UsageGuard(db, evlog, cfg, svc, permits); const idle = new IdleReaper(db, evlog, cfg, outbox, svc); const watchdog = new Watchdog(db, evlog, runner, svc, permits, foreign);
  // Installed before recover(), so replayed Stops are sampled and promoted too. Promotion runs BEFORE the task service
  // re-runs the outbox queue, so a delivered mid-turn send is no longer an `unknown` head blocking that queue.
  const prevStop = svc.ingestDeps.onStop;
  svc.ingestDeps.onStop = (t, b) => { const path = String(b.transcript_path ?? ""); usage.sampleTranscript(t, path); outbox.promoteFromTranscript(t.uuid, path); prevStop(t, b); };
  /** A worker reply on relay's own inbox socket. It carries no session id and no in-reply-to: the sender is resolved
   *  through the session registry, and anything that does not resolve to one of our tasks is dropped, never fed to a
   *  task or the dispatcher. `[relay #<id8>]` in the body is the mid-turn delivery proof for that task's sends. */
  onPeerFrame = (frame) => {
    const text = frameText(frame); const sid = sessionIdForSocket(frame?.from);
    const row = sid ? ((db.query("select uuid from tasks where session_id=?").get(sid) ?? db.query("select task_uuid as uuid from process_instances where session_id=? order by generation desc limit 1").get(sid)) as any) : null;
    if (!row) { log.warn("orphan peer frame — no task owns that sender socket", { from: frame?.from, hop_chain: text.match(/hop-chain="([^"]+)"/)?.[1] ?? null }); return; }
    const markers = markersIn(text);
    evlog.emit({ type: "message.sent", task_uuid: row.uuid, payload: { direction: "in", from_session: sid, text: text.slice(0, 500), markers, outcome: "accepted" } });
    for (const m of markers) outbox.markAccepted(row.uuid, m);   // ponytail: needs the worker to echo the marker — `agents/relay-worker.md` (plan 01) must say so; the transcript scan is the fallback until it does
  };
  svc.onToolUse = (t, promptId) => { if (usage.countToolCall(t.uuid, promptId)) { log.warn("tool-call cap hit — interrupting", { task: t.uuid }); svc.interrupt(t.uuid); } };
  svc.onNudge = () => { watchdog.tick().catch((e) => log.warn("watchdog", { e: String(e) })); };
  const ctx: AppContext = { db, cfg, log: evlog, hub, tokens, services: { ingestDeps: svc.ingestDeps, tasks: svc, outbox, scheduler, dispatcher, permits, pendingPermissions }, foreign, dashboardHtml: () => Bun.file(dashboardHtml as unknown as string).text() };
  const http = startServer(ctx); log.info("listening", { port: cfg.port });
  const spool = new Spool(paths.spool, () => svc.ingestDeps);
  await recover({ db, log: evlog, runner, permits, outbox, dispatcher, scheduler, tasks: svc, spool, maxAgents, instanceId });
  const timers = [setInterval(() => idle.tick(), 60_000), setInterval(() => usage.tick(), 60_000), setInterval(() => watchdog.tick().catch((e) => log.warn("watchdog", { e: String(e) })), 5_000), setInterval(() => spool.drain().catch(() => {}), 30_000), setInterval(() => spool.sweep(7), 3600_000),
    setInterval(() => { try { log.info("retention", sweep(db, 90, evlog)); } catch (e) { log.warn("retention", { e: String(e) }); } }, 24 * 3600_000)];
  const stop = () => { timers.forEach(clearInterval); for (const p of pendingPermissions.values()) p.resolve("deny"); http.stop(); peer?.stop(); db.close(); };   // never leave a worker waiting on a dead relay
  process.on("SIGTERM", () => { stop(); process.exit(0); }); process.on("SIGINT", () => { stop(); process.exit(0); });
  return { ctx, stop };
}
