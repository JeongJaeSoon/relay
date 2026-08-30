// src/cli/doctor.ts — diagnostics (§18). runChecks/probeCapabilities are library functions (no process.exit); only doctor() exits.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { homedir } from "node:os"; import { join } from "node:path";
import { loadConfig, paths } from "../config.ts";
import { openDb } from "../db/db.ts";
import { NativeSessionRunner } from "../runner/native.ts";
import { has, relayBin } from "./client.ts";
export interface Check { name: string; ok: boolean; detail: string; fix?: string }
export const checkPerms = (p: string, mode: number): Check => { if (!existsSync(p)) return { name: p, ok: false, detail: "없음" }; const m = statSync(p).mode & 0o777; return { name: p, ok: m === mode, detail: m.toString(8), fix: m === mode ? undefined : `chmod ${mode.toString(8)} ${p}` }; };
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
  try { return (JSON.parse(txt) as Check[]).map((c) => ({ ...c, name: `[service] ${c.name}` })); } catch { return [{ name: "[service] doctor", ok: false, detail: txt.slice(0, 160) || "no output", fix: "서비스 PATH/권한 확인: relay doctor --service 재실행" }]; }
}
/** Library entry: every check, no process.exit (setup reuses pieces, tests call it directly). */
export async function runChecks(opts: { service?: boolean; probe?: boolean } = {}): Promise<Check[]> {
  const cfg = loadConfig(); const r: Check[] = []; const pathEnv = [...cfg.path_prepend, process.env.PATH ?? ""].join(":");
  const ver = (await run([cfg.claude_bin, "--version"])).out.trim(); r.push({ name: "claude CLI", ok: /(\d+)\.(\d+)\.(\d+)/.test(ver) && (await import("./setup.ts")).versionOk(ver), detail: ver || "없음", fix: "claude update" });
  const login = await run([cfg.claude_bin, "-p", "reply OK", "--tools", "", "--max-turns", "1", "--effort", "low", "--output-format", "json"], 60_000); r.push({ name: "CLI 로그인", ok: login.code === 0 && !/"is_error":true/.test(login.out), detail: login.code === 0 ? "ok" : login.err.slice(0, 80), fix: "claude → /login" });
  for (const bin of ["node", "claude"]) { const w = await run(["sh", "-c", `PATH="${pathEnv}" command -v ${bin}`]); r.push({ name: `PATH에서 ${bin}`, ok: w.code === 0, detail: w.out.trim(), fix: "relay setup (path_prepend 갱신)" }); }
  r.push({ name: "ANTHROPIC_API_KEY 미설정", ok: !process.env.ANTHROPIC_API_KEY, detail: process.env.ANTHROPIC_API_KEY ? "설정됨(서비스에서는 제거됨)" : "", fix: "unset ANTHROPIC_API_KEY" });
  r.push({ name: "git", ok: (await run(["git", "--version"])).code === 0, detail: "" });
  const up = await fetch(`http://127.0.0.1:${cfg.port}/api/usage`, { headers: { authorization: `Bearer ${existsSync(paths.apiToken) ? readFileSync(paths.apiToken, "utf8").trim() : ""}` } }).then((x) => x.ok).catch(() => false); r.push({ name: `서버 :${cfg.port}`, ok: true, detail: up ? "실행 중" : "꺼짐", fix: up ? undefined : "brew services start relay" });
  if (existsSync(paths.serviceFailed)) r.push({ name: "서비스 기동 실패 플래그", ok: false, detail: `버전 ${readFileSync(paths.serviceFailed, "utf8").trim()} 기동 실패 후 잠든 상태`, fix: `원인 확인(~/Library/Logs/relay/stderr.log) 후: rm ${paths.serviceFailed} && brew services restart relay` });
  if (existsSync(paths.db)) { const db = openDb(paths.db); const ic = (db.query("pragma integrity_check").get() as any)?.integrity_check; db.close(); r.push({ name: "DB 무결성", ok: ic === "ok", detail: String(ic), fix: "relay db restore <backup>" }); }
  for (const f of [paths.apiToken, paths.hookToken]) if (existsSync(f)) r.push({ ...checkPerms(f, 0o600), name: `토큰 권한 ${f}` });
  if (existsSync(paths.spool)) { const q = existsSync(join(paths.spool, "quarantine")) ? readdirSync(join(paths.spool, "quarantine")).length : 0; r.push({ name: "훅 스풀", ok: q === 0, detail: `격리 ${q}건`, fix: `ls ${join(paths.spool, "quarantine")}` }); }
  for (const n of ["relay-worker.md", "relay-explore.md", "relay-verify.md"]) r.push({ name: `에이전트 ${n}`, ok: existsSync(join(paths.agentsDir, n)), detail: "", fix: "relay setup" });
  const mcp = await run([cfg.claude_bin, "mcp", "get", "relay"]); const mcpCmd = mcp.out.match(/(?:command|Command)[^:]*:\s*(\S+)/)?.[1] ?? null;   // a stale Cellar path after brew upgrade still "exists" in the registry but not on disk
  r.push({ name: "MCP relay 등록", ok: mcp.code === 0 && (!mcpCmd || existsSync(mcpCmd)), detail: mcpCmd ?? (mcp.code === 0 ? "등록됨" : "없음"), fix: `${cfg.claude_bin} mcp remove --scope user relay; relay setup` });
  const ds = await run([cfg.claude_bin, "daemon", "status"]);   // hidden subcommand (not in --help); informational only — a stopped supervisor is normal and starts on the first --bg
  r.push({ name: "claude 슈퍼바이저", ok: true, detail: ds.code === 0 ? `pid ${parseDaemonStatus(ds.out).pid} · ${parseDaemonStatus(ds.out).version}` : "미실행(첫 --bg 때 자동 시작)" });
  r.push({ name: "capabilities", ok: existsSync(paths.capabilities), detail: existsSync(paths.capabilities) ? `delivery=${JSON.parse(readFileSync(paths.capabilities, "utf8")).delivery}` : "없음", fix: "relay doctor --probe" });
  if (opts.probe) r.push(await probeCapabilities(cfg.claude_bin));
  if (opts.service) { r.push(...(await serviceChecks())); r.push({ name: "[service] Keychain 인증", ok: (await serviceAuthProbe(cfg.claude_bin)) === "keychain" || existsSync(paths.oauthToken), detail: existsSync(paths.oauthToken) ? "토큰 파일 폴백" : "", fix: "claude setup-token → relay setup --service" }); }
  return r;
}
/** CLI entry: the only function here that exits. */
export async function doctor(rest: string[]) {
  const r = await runChecks({ service: has(rest, "--service"), probe: has(rest, "--probe") });
  if (has(rest, "--json")) process.stdout.write(JSON.stringify(r, null, 2) + "\n"); else if (!has(rest, "--quiet")) process.stdout.write(summarize(r) + "\n");
  process.exit(r.some((c) => !c.ok) ? 1 : 0);
}
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
    if (!row?.session_id) return { name: "capability probe", ok: false, detail: "--bg 세션이 idle이 되지 않음(45s)" };
    await runner.stop(short); if (!(await poll((rows) => !rows.some((r) => r.short_id === short && r.alive), 15_000))) return { name: "capability probe", ok: false, detail: "stop이 확인되지 않음" };
    const r = await runner.resume({ sessionId: row.session_id, cwd, name: "relay-probe", settingsJson: "{}", prompt: "What was the word? Reply with it only.", env: {} }); short2 = r.short_id;
    const ok = !!(await poll((rows) => rows.some((x) => x.short_id === short2 && x.alive), 30_000));
    const caps = existsSync(paths.capabilities) ? JSON.parse(readFileSync(paths.capabilities, "utf8")) : {};
    writeFileSync(paths.capabilities, JSON.stringify({ ...caps, cli_version: (await run([claudeBin, "--version"])).out.trim(), bgResume: ok ? "context-kept" : "fail", ...(ok ? { delivery: caps.delivery ?? "resume" } : {}), probed_at: new Date().toISOString() }, null, 2));   // no print fallback (C9)
    return { name: "capability probe", ok, detail: ok ? "--bg --resume ok" : "--bg --resume 실패 — Phase 0 ① 재검토 필요(print 폴백 없음)" };
  } catch (e) { return { name: "capability probe", ok: false, detail: String(e).slice(0, 160) }; }
  finally { await cleanup([short2, short]); }
}
