// spikes/scripts/lib.ts — shared helpers for Phase 0 spike scripts.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SPIKES = new URL("../", import.meta.url).pathname;      // <repo>/spikes/
export const RESULTS = join(SPIKES, "results");
export const FIXTURES = join(SPIKES, "fixtures");
export const SANDBOX = join(SPIKES, "sandbox");
for (const d of [RESULTS, FIXTURES]) mkdirSync(d, { recursive: true });

export const CLEAN_ENV: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(([k, v]) => k !== "ANTHROPIC_API_KEY" && v !== undefined) as [string, string][],
);

export async function sh(cmd: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; stdin?: string } = {}) {
  const p = Bun.spawn(cmd, {
    cwd: opts.cwd, env: { ...CLEAN_ENV, ...(opts.env ?? {}) },
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill("SIGTERM"), opts.timeoutMs ?? 120_000);
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited; clearTimeout(timer);
  return { code, stdout, stderr };
}

export async function agents(all = false): Promise<any[]> {
  const r = await sh(["claude", "agents", "--json", ...(all ? ["--all"] : [])], { timeoutMs: 20_000 });
  try { return JSON.parse(r.stdout || "[]"); } catch { return []; }
}
export const spikeAgents = async (all = false) => (await agents(all)).filter((a) => String(a.name ?? "").startsWith("relay-spike:"));

export function parseBg(stdout: string): { short: string; name: string } | null {
  const m = stdout.match(/backgrounded · (\S+) · (.+)/);
  return m ? { short: m[1], name: m[2].trim() } : null;
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false | null>, timeoutMs: number, every = 500): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn(); if (v) return v as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout after ${timeoutMs}ms`);
    await Bun.sleep(every);
  }
}

const CAP = join(RESULTS, "capabilities.json");
export function record(patch: Record<string, unknown>) {
  const cur = existsSync(CAP) ? JSON.parse(readFileSync(CAP, "utf8")) : {};
  writeFileSync(CAP, JSON.stringify({ ...cur, ...patch, updated_at: new Date().toISOString() }, null, 2) + "\n");
}
export const caps = () => (existsSync(CAP) ? JSON.parse(readFileSync(CAP, "utf8")) : {});

const SECRET = /(sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36}|Bearer [A-Za-z0-9._-]{20,})/g;
export function fixture(name: string, data: unknown) {
  writeFileSync(join(FIXTURES, `${name}.json`), JSON.stringify(data, null, 2).replace(SECRET, "[redacted]") + "\n");
}

export function hookLines(file: string): any[] {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}
export const logLine = (file: string, obj: unknown) => appendFileSync(file, JSON.stringify(obj) + "\n");

// WorktreeCreate/WorktreeRemove are NOT observation hooks: measured 2026-08-30, a registered WorktreeCreate hook is
// expected to CREATE the worktree and return its path (command: echo to stdout; http: hookSpecificOutput.worktreePath).
// Returning an empty body kills the session before init ("hook succeeded but returned no worktree path"), so relay must
// never register them just to watch. See capabilities.worktreeCreateHook and spikes/fixtures/worktree-create.json.
export const ALL_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest",
  "PermissionDenied", "SubagentStart", "SubagentStop", "Notification", "Stop", "SessionEnd"];

/** Build the --settings JSON that injects hooks into one session only. SessionStart uses a command hook (http did not arrive in §14.1). */
export function settings(port: number, events: string[] = ALL_EVENTS, extra: Record<string, unknown> = {}, sessionStartHttp = false) {
  const http = { type: "http", url: `http://127.0.0.1:${port}/hook`, timeout: 3 };
  const hooks: Record<string, unknown> = {};
  for (const e of events) {
    if (e === "SessionStart" && !sessionStartHttp) {
      hooks[e] = [{ hooks: [{ type: "command", timeout: 3,
        command: `curl -s -m 2 -X POST -H 'content-type: application/json' --data-binary @- 'http://127.0.0.1:${port}/hook?e=SessionStart' >/dev/null 2>&1; exit 0` }] }];
    } else hooks[e] = [{ hooks: [http] }];
  }
  return JSON.stringify({ crossSessionInbound: "accept", hooks, ...extra });
}

/** Resolve a session's inbox socket. Measured 2026-08-30: `agents --json` has no pid for background rows, but every
 *  session (background included) writes ~/.claude/sessions/<pid>.json with sessionId + messagingSocketPath + status. */
export function peerRegistry(): any[] {
  const dir = join(process.env.HOME ?? "", ".claude", "sessions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
    try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return null; }
  }).filter(Boolean);
}
export const peerSocketFor = (sessionId: string): string | null => peerRegistry().find((r) => r.sessionId === sessionId)?.messagingSocketPath ?? null;

/** Send one line-delimited frame to a session inbox socket and collect whatever comes back within waitMs. */
export async function socketSend(sockPath: string, frame: unknown, waitMs = 5000): Promise<{ replies: unknown[]; error: string | null }> {
  const replies: unknown[] = []; let error: string | null = null;
  await new Promise<void>((resolve) => {
    let done = false; const fin = () => { if (!done) { done = true; resolve(); } };
    Bun.connect({ unix: sockPath, socket: {
      open(s) { s.write(JSON.stringify(frame) + "\n"); setTimeout(() => { s.end(); fin(); }, waitMs); },
      data(_s, b) { for (const l of b.toString().split("\n").filter(Boolean)) { try { replies.push(JSON.parse(l)); } catch { replies.push({ unparsed: l }); } } },
      close() { fin(); }, error(_s, e) { error = String(e); fin(); },
    } }).catch((e) => { error = String(e); fin(); });
  });
  return { replies, error };
}

/** Build the measured cross-session frame (spikes/fixtures/peer-frames.json). */
export const peerFrame = (fromSock: string, fromName: string, text: string) => ({
  msgV: 1, msg_id: crypto.randomUUID(), type: "user",
  message: { role: "user", content: `<cross-session-message from="uds:${fromSock}" from-name="${fromName}" from-mode="prompting">\n${text}\n</cross-session-message>` },
  priority: "next", from: `uds:${fromSock}`,
});

/** Spawn the hook receiver and remember it, so bail() below never leaves a listener holding the port between runs. */
const HOOKDS: { kill: (s?: number | NodeJS.Signals) => void }[] = [];
export function spawnHookd(port: number, log: string, args: string[] = [], env: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", join(SPIKES, "scripts", "hookd.ts"), String(port), log, ...args], { stdout: "inherit", stderr: "inherit", env: { ...CLEAN_ENV, ...env } });
  HOOKDS.push(p);
  return p;
}
export const killHookds = () => { for (const p of HOOKDS) { try { p.kill(); } catch {} } };

export function check(name: string, ok: boolean, detail = ""): boolean {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  return ok;
}
export async function stopAndRm(short: string) {
  await sh(["claude", "stop", short], { timeoutMs: 15_000 });
  await sh(["claude", "rm", short], { timeoutMs: 15_000 });
}
/** Stop+rm every relay-spike:* session (backstop so a failed run never leaks subscription usage). */
export async function cleanupSpikes() { for (const a of await spikeAgents(true)) { try { await stopAndRm(a.id); } catch {} } }
export const versionOk = (v: string, min: [number, number, number] = [2, 1, 251]) => { const m = v.match(/(\d+)\.(\d+)\.(\d+)/); if (!m) return false; const [a, b, c] = m.slice(1).map(Number); const [x, y, z] = min; return a > x || (a === x && (b > y || (b === y && c >= z))); };
// Every spike script imports this module, so a crash, an unhandled rejection (waitFor timeout) or Ctrl-C always cleans up.
let cleaning = false;
const bail = (code: number) => async (e?: unknown) => { if (cleaning) return; cleaning = true; if (e) console.error(e); await cleanupSpikes(); killHookds(); process.exit(code); };
process.on("SIGINT", bail(130)); process.on("SIGTERM", bail(143)); process.on("uncaughtException", bail(1)); process.on("unhandledRejection", bail(1));
