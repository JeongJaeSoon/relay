import type { AgentRow, AgentRunner, SpawnSpec } from "./runner.ts";
type Hook = (body: Record<string, unknown>, taskUuid: string) => void;

/** Scripted runner for tests: records calls, keeps an in-memory agent table, and can replay hook payloads through `ingest`. */
export class FakeRunner implements AgentRunner {
  calls: { kind: string; args: unknown }[] = []; rows = new Map<string, AgentRow>(); private n = 0;
  constructor(public ingest: Hook = () => {}) {}
  private mk(name: string, cwd: string, sessionId: string = crypto.randomUUID()) { const short = `fake${++this.n}`; this.rows.set(short, { short_id: short, session_id: sessionId, name, cwd, pid: 1000 + this.n, alive: true, busy: true, waiting_for: null, raw: {} }); return short; }
  async spawn(spec: SpawnSpec) { this.calls.push({ kind: "spawn", args: spec }); const short = this.mk(spec.name, spec.cwd); return { short_id: short, name: spec.name }; }
  /** `claude --bg --resume <uuid>` FORKS: the resumed session gets a NEW session id and reports SessionStart
   *  source "fork" (Phase 0 ④). Only the supervisor's own respawn keeps the id. */
  async resume(p: { sessionId: string; cwd: string; name: string; prompt: string }) { this.calls.push({ kind: "resume", args: p }); return { short_id: this.mk(p.name, p.cwd) }; }
  async stop(shortId: string) { this.calls.push({ kind: "stop", args: shortId }); const r = this.rows.get(shortId); if (r) { r.alive = false; r.pid = null; r.busy = null; } }
  /** Set to make `rm` refuse the way the CLI does — the session stays in `rows`, exactly as its row stays in
   *  `agents --json --all`. Without this the refusal path, which is the COMMON one in a real install, is untestable. */
  keepWorktree: { reason: string; keptPath?: string; retryable?: boolean } | null = null;
  async rm(shortId: string) {
    this.calls.push({ kind: "rm", args: shortId });
    if (this.keepWorktree) return { worktreeKept: true, ...this.keepWorktree };
    this.rows.delete(shortId); return { worktreeKept: false };
  }
  async list(all = false) { return [...this.rows.values()].filter((r) => all || r.alive); }
  /** Test helper: simulate the session's hooks. */
  hooks(short: string, taskUuid: string, events: Record<string, unknown>[]) { const r = this.rows.get(short)!; for (const e of events) this.ingest({ session_id: r.session_id, transcript_path: "/dev/null", cwd: r.cwd, ...e }, taskUuid); }
}
