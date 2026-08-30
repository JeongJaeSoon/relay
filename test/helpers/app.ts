// test/helpers/app.ts — assembles the whole server in memory with a FakeRunner and a scripted dispatcher (unit + integration tests).
import { openDb, migrate } from "../../src/db/db.ts";
import { parseConfig } from "../../src/config.ts";
import { EventLog } from "../../src/core/events.ts";
import { WsHub } from "../../src/gateway/ws.ts";
import { hookTokenFor } from "../../src/gateway/auth.ts";
import type { PendingPermission } from "../../src/hooks/ingest.ts";
import { buildApp, type AppContext } from "../../src/gateway/server.ts";
import { PermitPool } from "../../src/core/permits.ts";
import { Scheduler } from "../../src/core/queue.ts";
import { Outbox } from "../../src/lifecycle/outbox.ts";
import { FakeRunner } from "../../src/runner/fake.ts";
import { ForeignSessions } from "../../src/lifecycle/foreign.ts";
import { TaskService } from "../../src/core/tasks.ts";
import { Dispatcher, type RunClaude } from "../../src/dispatcher/dispatcher.ts";
import { assertInvariants } from "../../src/core/state.ts";
export const decide = (o: unknown): RunClaude => async () => ({ code: 0, stdout: JSON.stringify({ structured_output: o, usage: { input_tokens: 10, output_tokens: 1 } }), stderr: "" });
export async function buildTestApp(runClaude?: RunClaude, max = 10) {
  const cfg = parseConfig(""); const db = openDb(":memory:"); migrate(db);
  let hub!: WsHub; let foreign!: ForeignSessions;
  const log = new EventLog(db, (f) => hub.broadcast(f), cfg); hub = new WsHub(() => log, cfg, db, () => foreign.list());
  log.emit({ type: "project.registered", payload: { id: "p1", name: "myapp", path: "/tmp/myapp", description: "", keywords: [], base_ref: "head", is_git: true, created_at: 1 } });   // via the log, so replay can rebuild it
  let maxAgents = max; const permits = new PermitPool(db, log, () => maxAgents); const runner = new FakeRunner(); let svc!: TaskService;
  const outbox = new Outbox(db, log, runner, { delivery: () => "resume", isPaused: () => svc.paused(), settingsJson: () => "{}", env: () => ({}), socketPathFor: (r) => `/tmp/${r.pid}.sock`, instanceId: () => "inst-test" });
  const scheduler = new Scheduler(db, log, permits, (t) => svc.startSlot(t), () => svc.paused());
  const pendingPermissions = new Map<string, PendingPermission>(); svc = new TaskService({ db, log, cfg, permits, scheduler, outbox, projectNameOf: () => "myapp", pendingPermissions });
  const dispatcher = new Dispatcher(db, log, cfg, { runClaude: runClaude ?? decide({ action: "answer_directly", answer: "ok", confidence: "high" }), onDecision: (m, d, p) => svc.applyDecision(m, d, p), onNeedsConfirm: (m, d, r) => svc.needsConfirm(m, d, r), isPaused: () => svc.paused() });
  foreign = new ForeignSessions(db, runner, (list) => hub.broadcastForeign(list));
  const ctx: AppContext = { db, cfg, log, hub, tokens: { api: "API", hook: "HOOK" }, services: { ingestDeps: svc.ingestDeps, tasks: svc, outbox, scheduler, dispatcher, permits, pendingPermissions }, foreign, dashboardHtml: async () => "<html><head></head><body></body></html>" };
  const { app } = buildApp(ctx);
  const req = (method: string, path: string, body?: unknown) => app.request(`http://127.0.0.1:8790${path}`, { method, headers: { host: "127.0.0.1:8790", authorization: "Bearer API", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const hookReq = (taskUuid: string, body: Record<string, unknown>) => app.request("http://127.0.0.1:8790/api/hooks", { method: "POST", headers: { host: "127.0.0.1:8790", authorization: `Bearer ${hookTokenFor("HOOK", taskUuid)}`, "content-type": "application/json", "x-relay-task": taskUuid }, body: JSON.stringify(body) });
  let seedN = 0;
  /** A task with a live fake session (unique num/session/short id per call). */
  const seedTask = (status: string, extra: Record<string, unknown> = {}) => { const uuid = crypto.randomUUID(); const n = ++seedN; log.emit({ type: "task.created", task_uuid: uuid, payload: { uuid, num: n, display_id: `T-0${n}`, project_id: "p1", title: "t", status, size: "normal", effort: "xhigh", model: "m", session_id: `sid${n}`, short_id: `fake0${n}`, worktree_path: null, branch: null, base_sha: null, process_state: "alive", process_generation: 1, turn_state: "busy", attach_state: "none", attached_by: null, paused: false, last_summary: null, last_step: null, question: null, parent_uuid: null, agent_id: null, agent_type: null, queued_at: null, qhead: false, started_at: 1, ended_at: null, created_at: 1, updated_at: 1, closed_at: null, usage_tokens: 0, ...extra } }); runner.rows.set(`fake0${n}`, { short_id: `fake0${n}`, session_id: `sid${n}`, name: "n", cwd: "/tmp/myapp", pid: n, alive: true, busy: true, waiting_for: null, raw: {} }); return uuid; };
  const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  const invariants = () => assertInvariants(db, maxAgents);
  return { app, ctx, db, log, hub, runner, svc, dispatcher, outbox, permits, scheduler, foreign, req, hookReq, seedTask, settle, invariants, setMax: (n: number) => { maxAgents = n; } };
}
