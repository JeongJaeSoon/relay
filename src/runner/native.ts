import type { AgentRow, AgentRunner, SpawnSpec } from "./runner.ts";
import type { SendOutcome } from "@shared/types.ts";
import { buildFrame, sendFrame, type PeerFixture } from "./peer.ts";
import { log } from "../log.ts";

export const parseBg = (stdout: string) => { const m = stdout.match(/backgrounded · (\S+) · (.+)/); return m ? { short: m[1], name: m[2].trim() } : null; };

/** `claude rm` has more than one refusal and each needs a different move from the user. Measured on CLI 2.1.251
 *  (2026-08-31), one line each, all beginning `kept <id> — `:
 *    · `worktree has commits that are not pushed anywhere`  ← the shape a SUCCESSFUL relay worker leaves behind
 *      (`agents/relay-worker.md`: commit locally, never push, leave the tree clean; `allow_push` defaults to false)
 *    · `worktree has uncommitted changes`
 *    · `worktree is locked — in use by another live session, or locked by hand`
 *  followed by `  worktree kept at <path>`. A removal prints `removed <id>` and exits 0. */
export function parseRm(out: string) {
  const kept = /kept|uncommitted|preserv/i.test(out);
  if (!kept) return { worktreeKept: false };
  return { worktreeKept: true, reason: out.match(/^\s*kept\s+\S+\s+[—–-]\s*(.+?)\s*$/m)?.[1], keptPath: out.match(/^\s*worktree kept at\s+(.+?)\s*$/m)?.[1] };
}
const DEAD_STATES = ["stopped", "done", "failed"];
/** Accepts both the documented vocabulary (state working|blocked|done|failed|stopped, status working|waiting) and the
 *  observed one (state working|done, status busy|idle). Phase 0 measured that `agents --json` carries **no `pid` for
 *  background rows**, so liveness is decided by `state`/`status` and pid is only extra evidence — requiring it would
 *  make every worker look dead. */
export function normalizeAgentRow(raw: any): AgentRow {
  const state = String(raw.state ?? ""); const status = raw.status == null ? null : String(raw.status);
  const alive = !DEAD_STATES.includes(state) && (raw.pid != null || state !== "" || status != null);
  const busy = status == null ? null : ["busy", "working"].includes(status);
  return { short_id: raw.id ?? null, session_id: raw.sessionId ?? null, name: raw.name ?? null, cwd: raw.cwd ?? null, pid: alive && raw.pid != null ? Number(raw.pid) : null, alive, busy, waiting_for: raw.waitingFor ?? null, raw };
}

export function spawnArgs(s: SpawnSpec): string[] {
  // ponytail: `--advisor` is in the design (epic tasks get a fable advisor) but CLI 2.1.251 has no such flag
  // (Phase 0 `capabilities.advisorFlag = false`). `spec.advisor` is still carried so the decision is recorded and the
  // flag can be added the day the CLI grows one — it is simply not passed on the command line today.
  return ["--bg", ...(s.worktree ? ["-w", s.worktree] : []), "-n", s.name, "--agent", s.agent, "--model", s.model, "--effort", s.effort, "--permission-mode", s.permissionMode,
    "--settings", s.settingsJson, s.prompt];
}

export interface NativeOpts { claudeBin?: string; peer?: { fixture: PeerFixture; socketPath: string; sessionId: string } }
export class NativeSessionRunner implements AgentRunner {
  private bin: string;
  sendSocket?: (socketPath: string, text: string, msgId: string) => Promise<SendOutcome>;
  constructor(private baseEnv: () => Record<string, string>, opts: NativeOpts = {}) {
    this.bin = opts.claudeBin ?? "claude";
    if (opts.peer) { const peer = opts.peer; this.sendSocket = async (sp, text, id) => (await sendFrame(sp, buildFrame(peer.fixture, { msgId: id, text, fromSocket: peer.socketPath, fromName: "relay", fromSession: peer.sessionId }))).outcome; }
  }
  private async run(args: string[], cwd: string, env: Record<string, string>, timeoutMs = 60_000) {
    const p = Bun.spawn([this.bin, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const t = setTimeout(() => p.kill("SIGTERM"), timeoutMs);
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited; clearTimeout(t); return { code, stdout, stderr };
  }
  async spawn(spec: SpawnSpec) {
    const r = await this.run(spawnArgs(spec), spec.cwd, { ...this.baseEnv(), ...spec.env });
    const bg = parseBg(r.stdout); if (!bg) throw new Error(`spawn failed (${r.code}): ${r.stderr.slice(0, 300) || r.stdout.slice(0, 300)}`);
    return { short_id: bg.short, name: bg.name };
  }
  async resume(p: { sessionId: string; cwd: string; name: string; settingsJson: string; prompt: string; env: Record<string, string> }) {
    const r = await this.run(["--bg", "--resume", p.sessionId, "-n", p.name, "--settings", p.settingsJson, p.prompt], p.cwd, { ...this.baseEnv(), ...p.env });
    const bg = parseBg(r.stdout); if (!bg) throw new Error(`resume failed (${r.code}): ${r.stderr.slice(0, 300)}`);
    return { short_id: bg.short };
  }
  async stop(shortId: string) { const r = await this.run(["stop", shortId], process.cwd(), this.baseEnv(), 20_000); if (r.code !== 0) log.warn("claude stop non-zero", { shortId, stderr: r.stderr.slice(0, 200) }); }
  async rm(shortId: string) { const r = await this.run(["rm", shortId], process.cwd(), this.baseEnv(), 30_000); return parseRm(r.stdout + r.stderr); }
  /** Throws on failure: callers (watchdog, recovery) must treat "unknown" differently from "no sessions". */
  async list(all = false) {
    const r = await this.run(["agents", "--json", ...(all ? ["--all"] : [])], process.cwd(), this.baseEnv(), 20_000);
    if (r.code !== 0) throw new Error(`agents --json exit ${r.code}: ${r.stderr.slice(0, 200)}`);
    let rows: any[]; try { rows = JSON.parse(r.stdout); } catch { throw new Error(`agents --json unparseable: ${r.stdout.slice(0, 120)}`); }
    return rows.map(normalizeAgentRow);
  }
}
