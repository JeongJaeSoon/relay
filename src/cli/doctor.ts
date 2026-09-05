// src/cli/doctor.ts — diagnostics (§18). runChecks/probeCapabilities are library functions (no process.exit); only doctor() exits.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { homedir } from "node:os"; import { join } from "node:path";
import { loadConfig, paths } from "../config.ts";
import type { Database } from "bun:sqlite";
import { openDb } from "../db/db.ts";
import { NativeSessionRunner } from "../runner/native.ts";
import type { AgentRow } from "../runner/runner.ts";
import { FOREIGN_GRACE_MS, foreignRows, ownership } from "../lifecycle/foreign.ts";
import { driftWarns, loadCapabilities, showVersion, versionDrift, versionOk, type DriftLevel } from "../runner/capabilities.ts";
import { has, relayBin } from "./client.ts";
export interface Check { name: string; ok: boolean; detail: string; fix?: string }
export const checkPerms = (p: string, mode: number): Check => { if (!existsSync(p)) return { name: p, ok: false, detail: "missing" }; const m = statSync(p).mode & 0o777; return { name: p, ok: m === mode, detail: m.toString(8), fix: m === mode ? undefined : `chmod ${mode.toString(8)} ${p}` }; };
/** Tasks whose disposal did not finish and nothing has since removed: `claude rm` refused because the worktree holds
 *  work that exists nowhere else (uncommitted, or committed and never pushed), or the rm ended `unknown` and relay
 *  cannot tell. Relay records both honestly and stops there, so this is the only place they can be counted. A
 *  transient lock is not here on purpose — that rm is still pending and clears itself. */
export const keptSessions = (db: Database) => db.query("select t.display_id, t.worktree_path from tasks t where exists (select 1 from commands c where c.task_uuid=t.uuid and c.kind='rm' and c.state in ('failed','unknown') and json_extract(c.payload_json,'$.target') is null) and not exists (select 1 from commands c where c.task_uuid=t.uuid and c.kind='rm' and c.state='applied' and json_extract(c.payload_json,'$.target') is null)").all() as { display_id: string; worktree_path: string | null }[];
/** Includes superseded generations and in-flight cleanup: a successful older rm cannot hide a newer failure. */
export const pendingCleanup = (db: Database) => db.query(`select c.id, c.kind, c.state, c.error, t.display_id, t.worktree_path,
  coalesce(json_extract(c.payload_json,'$.target.session_id'),t.session_id) session_id
  from commands c join tasks t on t.uuid=c.task_uuid
  where c.kind in ('stop','rm') and c.state in ('pending','running','unknown','failed')
  and not exists (select 1 from commands newer where newer.task_uuid=c.task_uuid and newer.kind=c.kind
    and newer.rowid>c.rowid and newer.state='applied'
    and json_extract(newer.payload_json,'$.target.session_id') is json_extract(c.payload_json,'$.target.session_id'))
  order by c.rowid`).all() as { id: string; kind: string; state: string; error: string | null; display_id: string; worktree_path: string | null; session_id: string | null }[];
/** Roster rows no task accounts for. `close()` cannot reach these and `keptSessions` cannot see them: a task whose
 *  spawn never recorded a short id keeps `process_state='none'`, so close queues no stop and its rm is a no-op
 *  (`t.short_id ? runner.rm(...) : { worktreeKept: false }`) — the task closes cleanly with nothing in `commands` to
 *  find the session by. Ownership is `foreign.ts`'s, not a second notion of it: a name is never identity (B8), and
 *  `process_instances` carries the session ids a fork left behind. The grace window is the same one the foreign list
 *  waits out — a roster row exists before the outbox has recorded its short id — applied here to `startedAt`, since a
 *  one-shot check has no `first_seen` history. A `startedAt` that is missing OR unparseable is REPORTED, never hidden:
 *  arithmetic on a bad value gives NaN, every comparison against which is false, so the naive filter would go quiet
 *  exactly where the data is worst — the shape of the leaks this check exists to surface.
 *  Inherited from `foreign.ts`, not this check: for a NON-git project every task shares the launch cwd, so one
 *  `.relay-owner` there makes `stamped()` true for ANY row in it — hiding a genuinely external session someone started
 *  by hand in that directory just as much as an orphan. A false negative, and narrow, because the scheduler keeps a
 *  non-git project to one task at a time. */
export function unaccountedSessions(db: Database, rows: AgentRow[], t = Date.now(), graceMs = FOREIGN_GRACE_MS): AgentRow[] {
  return foreignRows(rows, ownership(db)).filter((r) => {
    const startedAt = Number((r.raw as { startedAt?: unknown })?.startedAt);
    return !Number.isFinite(startedAt) || t - startedAt >= graceMs;   // missing OR unparseable is reported, never silently hidden
  });
}
export const parseDaemonStatus = (t: string) => ({ pid: Number(t.match(/pid:\s*(\d+)/)?.[1] ?? 0), version: t.match(/version:\s*(\S+)/)?.[1] ?? "" });
export const summarize = (r: Check[]) => r.map((c) => `${c.ok ? "✔" : "✖"} ${c.name}${c.detail ? " — " + c.detail : ""}${!c.ok && c.fix ? `\n    → ${c.fix}` : ""}`).join("\n");
const probeEnv = (): Record<string, string> => Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k !== "ANTHROPIC_API_KEY" && v != null)) as Record<string, string>;
const run = async (cmd: string[], timeoutMs = 20_000) => { const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, ANTHROPIC_API_KEY: undefined } as any }); const t = setTimeout(() => p.kill(), timeoutMs); const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]); const code = await p.exited; clearTimeout(t); return { code, out, err }; };
/** Run one shell command as a throw-away launchd user agent and return what it wrote to `out` (Phase 0 ① technique). */
async function serviceRun(label: string, shellCmd: string, out: string, timeoutMs: number): Promise<string> {
  const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`); try { unlinkSync(out); } catch {}
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>${shellCmd.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</string></array><key>RunAtLoad</key><true/></dict></plist>`);
  const uid = process.getuid?.() ?? 501; await run(["launchctl", "bootout", `gui/${uid}/${label}`]); await run(["launchctl", "bootstrap", `gui/${uid}`, plist]);
  const t0 = Date.now(); while (Date.now() - t0 < timeoutMs && !(existsSync(out) && statSync(out).size > 0)) await Bun.sleep(1000);
  await run(["launchctl", "bootout", `gui/${uid}/${label}`]); try { unlinkSync(plist); } catch {}
  return existsSync(out) ? readFileSync(out, "utf8") : "";
}
/** `claude -p` under launchd: does the service context see the Keychain? (never --bare: bare mode skips OAuth/Keychain) */
export async function serviceAuthProbe(claudeBin: string): Promise<"keychain" | "needs-token" | "unknown"> {
  const out = join(paths.home, "doctor-auth.json");
  const txt = await serviceRun("dev.relay.doctor-auth", `env -u ANTHROPIC_API_KEY "${claudeBin}" -p "reply with exactly OK" --output-format json --tools "" --max-turns 1 --effort low > "${out}" 2>&1`, out, 60_000);
  if (/"is_error":false/.test(txt) && /OK/.test(txt)) return "keychain"; if (/not logged in|authentication|Invalid API key/i.test(txt)) return "needs-token"; return "unknown";
}
/** The whole check list, run inside a launchd user agent and merged with a [service] prefix. */
async function serviceChecks(): Promise<Check[]> {
  const out = join(paths.home, "doctor-service.json");
  const txt = await serviceRun("dev.relay.doctor", `${relayBin()} doctor --json --quiet > "${out}" 2>&1`, out, 120_000);
  try { return (JSON.parse(txt) as Check[]).map((c) => ({ ...c, name: `[service] ${c.name}` })); } catch { return [{ name: "[service] doctor", ok: false, detail: txt.slice(0, 160) || "no output", fix: "check the service PATH/permissions, then re-run relay doctor --service" }]; }
}
/** Library entry: every check, no process.exit (setup reuses pieces, tests call it directly). */
export async function runChecks(opts: { service?: boolean; probe?: boolean } = {}): Promise<Check[]> {
  const cfg = loadConfig(); const r: Check[] = []; const pathEnv = [...cfg.path_prepend, process.env.PATH ?? ""].join(":");
  const ver = (await run([cfg.claude_bin, "--version"])).out.trim(); r.push({ name: "claude CLI", ok: /(\d+)\.(\d+)\.(\d+)/.test(ver) && versionOk(ver), detail: ver || "missing", fix: "claude update" });
  const login = await run([cfg.claude_bin, "-p", "reply OK", "--tools", "", "--max-turns", "1", "--effort", "low", "--output-format", "json"], 60_000); r.push({ name: "CLI login", ok: login.code === 0 && !/"is_error":true/.test(login.out), detail: login.code === 0 ? "ok" : login.err.slice(0, 80), fix: "claude → /login" });
  for (const bin of ["node", "claude"]) { const w = await run(["sh", "-c", `PATH="${pathEnv}" command -v ${bin}`]); r.push({ name: `${bin} on PATH`, ok: w.code === 0, detail: w.out.trim(), fix: "relay setup (refreshes path_prepend)" }); }
  r.push({ name: "ANTHROPIC_API_KEY unset", ok: !process.env.ANTHROPIC_API_KEY, detail: process.env.ANTHROPIC_API_KEY ? "set (stripped in the service)" : "", fix: "unset ANTHROPIC_API_KEY" });
  r.push({ name: "git", ok: (await run(["git", "--version"])).code === 0, detail: "" });
  const up = await fetch(`http://127.0.0.1:${cfg.port}/api/usage`, { headers: { authorization: `Bearer ${existsSync(paths.apiToken) ? readFileSync(paths.apiToken, "utf8").trim() : ""}` } }).then((x) => x.ok).catch(() => false); r.push({ name: `server :${cfg.port}`, ok: true, detail: up ? "running" : "down", fix: up ? undefined : "brew services start relay" });
  if (existsSync(paths.serviceFailed)) r.push({ name: "service start-failure flag", ok: false, detail: `asleep after version ${readFileSync(paths.serviceFailed, "utf8").trim()} failed to start`, fix: `check the cause (~/Library/Logs/relay/stderr.log), then: rm ${paths.serviceFailed} && brew services restart relay` });
  if (existsSync(paths.db)) { const db = openDb(paths.db); const ic = (db.query("pragma integrity_check").get() as any)?.integrity_check;
    // Registration refuses a non-git root now, but a project registered before that rule still runs tasks in a shared
    // tree with no worktree and a guard boundary the size of the directory.
    const legacy = db.query("select name, path from projects where is_git = 0").all() as { name: string; path: string }[];
    const kept = keptSessions(db); const cleanup = pendingCleanup(db);
    let roster: AgentRow[] | null = null;
    try { roster = await new NativeSessionRunner(probeEnv, { claudeBin: cfg.claude_bin }).list(true); } catch (e) { r.push({ name: "background session roster", ok: false, detail: String(e).slice(0, 80), fix: `${cfg.claude_bin} agents --json --all` }); }
    const unaccounted = roster ? unaccountedSessions(db, roster) : [];
    db.close();
    r.push({ name: "owned session cleanup", ok: cleanup.length === 0, detail: cleanup.length ? cleanup.map(c => `${c.display_id} ${c.kind} ${c.state} ${c.id} session=${c.session_id ?? "?"} ${c.worktree_path ?? ""} ${c.error ?? ""}`).join("; ") : "converged", fix: cleanup.length ? "Inspect the task commands; retry failed/unknown cleanup with POST /api/commands/<id>/retry after resolving the reported cause" : undefined });
    r.push({ name: "DB integrity", ok: ic === "ok", detail: String(ic), fix: "relay db restore <backup>" });
    r.push({ name: "sessions relay could not deregister", ok: kept.length === 0, detail: kept.length ? kept.map((k) => `${k.display_id} ${k.worktree_path ?? "?"}`).join(", ") : "none",
      fix: kept.length ? `claude rm keeps a session whose worktree still holds work that exists nowhere else, or is locked. The task's last message says which. Resolve it (push or discard the branch; unlock or stop whatever holds the lock), then close the task again — or set worker.allow_push = true so workers push before they finish` : undefined });
    if (roster) r.push({ name: "background sessions relay cannot account for", ok: unaccounted.length === 0, detail: unaccounted.length ? unaccounted.map((x) => `${x.short_id ?? "?"} ${x.name ?? ""}`.trim()).join(", ") : "none",
      fix: unaccounted.length ? `these are alive and no task owns them — either a session started outside relay, or one whose spawn relay never recorded. Check them (claude logs <id>), then stop them from the dashboard's external-sessions list or with claude stop <id>` : undefined });
    if (legacy.length) r.push({ name: "project roots are git repositories", ok: false, detail: legacy.map((p) => `${p.name} (${p.path})`).join(", "),
      fix: `these were registered before the rule and get no worktree isolation — remove and re-add them: ${legacy.map((p) => `relay open → settings → remove "${p.name}"`).join("; ")}` });
  }
  for (const f of [paths.apiToken, paths.hookToken]) if (existsSync(f)) r.push({ ...checkPerms(f, 0o600), name: `token permissions ${f}` });
  if (existsSync(paths.spool)) { const q = existsSync(join(paths.spool, "quarantine")) ? readdirSync(join(paths.spool, "quarantine")).length : 0; r.push({ name: "hook spool", ok: q === 0, detail: `${q} quarantined`, fix: `ls ${join(paths.spool, "quarantine")}` }); }
  for (const n of ["relay-worker.md", "relay-explore.md", "relay-verify.md"]) r.push({ name: `agent ${n}`, ok: existsSync(join(paths.agentsDir, n)), detail: "", fix: "relay setup" });
  const mcp = await run([cfg.claude_bin, "mcp", "get", "relay"]); const mcpCmd = mcp.out.match(/(?:command|Command)[^:]*:\s*(\S+)/)?.[1] ?? null;   // a stale Cellar path after brew upgrade still "exists" in the registry but not on disk
  r.push({ name: "MCP relay registration", ok: mcp.code === 0 && (!mcpCmd || existsSync(mcpCmd)), detail: mcpCmd ?? (mcp.code === 0 ? "registered" : "missing"), fix: `${cfg.claude_bin} mcp remove --scope user relay; relay setup` });
  const ds = await run([cfg.claude_bin, "daemon", "status"]);   // hidden subcommand (not in --help); informational only — a stopped supervisor is normal and starts on the first --bg
  r.push({ name: "claude supervisor", ok: true, detail: ds.code === 0 ? `pid ${parseDaemonStatus(ds.out).pid} · ${parseDaemonStatus(ds.out).version}` : "not running (starts on the first --bg)" });
  r.push({ name: "capabilities", ok: existsSync(paths.capabilities), detail: existsSync(paths.capabilities) ? `delivery=${JSON.parse(readFileSync(paths.capabilities, "utf8")).delivery}` : "missing", fix: "relay doctor --probe" });
  if (existsSync(paths.capabilities)) { const caps = loadCapabilities(); r.push(cliDriftCheck(caps.cli_version, ver, caps.probe_cli_version)); }   // never probed is the check above's job, not this one's
  if (opts.probe) r.push(await probeCapabilities(cfg.claude_bin));
  if (opts.service) { r.push(...(await serviceChecks())); r.push({ name: "[service] Keychain auth", ok: (await serviceAuthProbe(cfg.claude_bin)) === "keychain" || existsSync(paths.oauthToken), detail: existsSync(paths.oauthToken) ? "token file fallback" : "", fix: "claude setup-token → relay setup --service" }); }
  return r;
}
const DRIFT_NOTE: Record<DriftLevel, string> = {
  same: "in sync", patch: "patch bump — this CLI ships its releases here, so the measured behaviour can still move",
  minor: "minor bump — the measured CLI behaviour may be stale", major: "major bump — expect the measured CLI behaviour to be stale",
  unknown: "not comparable",
};
export const DRIFT_FIX = "relay doctor --probe — re-checks the --bg --resume gate only; the rest of capabilities.json comes from the Phase 0 spikes and only a spike re-run refreshes it";
/** A probe spends a real background session, so never ask for one the user has already run against this CLI. */
export const DRIFT_FIX_PROBED = "the --bg --resume gate is already re-checked on this CLI — another probe would tell you nothing new; the rest of capabilities.json comes from the Phase 0 spikes and only a spike re-run refreshes it";
/** capabilities.json is measured once against one CLI build and nothing re-measures it on `claude update`, so a
 *  changed CLI otherwise shows up only as quiet misbehaviour (a spawn parsed as `unknown`, a hook payload that
 *  projects wrong). Probing is the user's call — it spawns a real session — so this only ever reports.
 *  `probed` is the gate's own stamp: it is reported, never used to clear the warning, because re-measuring two of
 *  the file's ~70 facts says nothing about the other 68. */
export function cliDriftCheck(recorded: string, current: string, probed?: string): Check {
  const level = versionDrift(recorded, current);
  const reprobed = driftWarns(level) && versionDrift(probed ?? "", current) === "same";
  const gate = reprobed ? ` · --bg --resume re-checked on ${showVersion(current)}` : "";
  return { name: "CLI version drift", ok: !driftWarns(level), detail: `probed against ${showVersion(recorded)} · currently ${showVersion(current)} (${DRIFT_NOTE[level]})${gate}`, fix: reprobed ? DRIFT_FIX_PROBED : DRIFT_FIX };
}
/** CLI entry: the only function here that exits. */
export async function doctor(rest: string[]) {
  const r = await runChecks({ service: has(rest, "--service"), probe: has(rest, "--probe") });
  if (has(rest, "--json")) process.stdout.write(JSON.stringify(r, null, 2) + "\n"); else if (!has(rest, "--quiet")) process.stdout.write(summarize(r) + "\n");
  process.exit(r.some((c) => !c.ok) ? 1 : 0);
}
/** What a probe run is allowed to write back. `cli_version` is deliberately absent from the result: it records the
 *  CLI the *whole* file was measured against, and this probe re-measures two of its ~70 facts. Restamping it would
 *  clear a true drift warning on the strength of a measurement that never happened — and on a failed probe it would
 *  do that while writing `bgResume: "fail"`. The probe's own reach is recorded separately, outcome either way.
 *  `delivery` moves only on success: a failed gate is no evidence for a delivery method (no print fallback, C9). */
export const mergeProbeResult = (caps: Record<string, any>, cliVersion: string, ok: boolean, at = new Date().toISOString()): Record<string, any> =>
  ({ ...caps, bgResume: ok ? "context-kept" : "fail", ...(ok ? { delivery: caps.delivery ?? "resume" } : {}), probe_cli_version: cliVersion, probed_at: at });
/** Abridged Phase 0 ①: --bg spawn → wait idle → stop → --bg --resume → alive. All CLI parsing lives in NativeSessionRunner (roadmap Global Constraints). Budget ≈ 90s. */
export async function probeCapabilities(claudeBin: string): Promise<Check> {
  const runner = new NativeSessionRunner(probeEnv, { claudeBin }); const cwd = join(paths.home, "probe"); mkdirSync(cwd, { recursive: true });
  const poll = async (pred: (rows: Awaited<ReturnType<typeof runner.list>>) => boolean, ms: number) => { const t0 = Date.now(); for (;;) { const rows = await runner.list(true); if (pred(rows)) return rows; if (Date.now() - t0 > ms) return null; await Bun.sleep(2000); } };
  const cleanup = async (ids: (string | null | undefined)[]) => { for (const id of ids) if (id) { try { await runner.stop(id); } catch {} try { await runner.rm(id); } catch {} } };   // `claude rm` refuses when the worktree holds uncommitted work — expected, not an error
  let short: string | null = null, short2: string | null = null;
  try {
    const s = await runner.spawn({ taskUuid: "probe", displayId: "P-00", name: "relay-probe", cwd, worktree: null, model: "claude-sonnet-5", effort: "low", permissionMode: "auto", advisor: null, agent: "relay-worker", settingsJson: "{}", prompt: "Remember the word KIWI and reply OK.", env: {} });
    short = s.short_id;
    const idle = await poll((rows) => rows.some((r) => r.short_id === short && r.session_id && r.busy === false), 45_000); const row = idle?.find((r) => r.short_id === short);
    if (!row?.session_id) return { name: "capability probe", ok: false, detail: "--bg session never went idle (45s)" };
    await runner.stop(short); if (!(await poll((rows) => !rows.some((r) => r.short_id === short && r.alive), 15_000))) return { name: "capability probe", ok: false, detail: "stop was not confirmed" };
    const r = await runner.resume({ sessionId: row.session_id, cwd, name: "relay-probe", settingsJson: "{}", prompt: "What was the word? Reply with it only.", env: {} }); short2 = r.short_id;
    const ok = !!(await poll((rows) => rows.some((x) => x.short_id === short2 && x.alive), 30_000));
    const caps = existsSync(paths.capabilities) ? JSON.parse(readFileSync(paths.capabilities, "utf8")) : {};
    writeFileSync(paths.capabilities, JSON.stringify(mergeProbeResult(caps, (await run([claudeBin, "--version"])).out.trim(), ok), null, 2));
    return { name: "capability probe", ok, detail: ok ? "--bg --resume ok" : "--bg --resume failed — Phase 0 ① needs a rethink (no print fallback)" };
  } catch (e) { return { name: "capability probe", ok: false, detail: String(e).slice(0, 160) }; }
  finally { await cleanup([short2, short]); }
}
