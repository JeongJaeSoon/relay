// src/cli/setup.ts — first-run wizard (§18): claude CLI, service auth, config, projects, agent definitions, MCP, capabilities.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { ConfigSchema, loadConfig, paths, ensureDirs, type Config } from "../config.ts";
import { client, relayArgv, has } from "./client.ts";
import worker from "../../agents/relay-worker.md" with { type: "file" };     // embedded straight from the source files (bun build --compile)
import explore from "../../agents/relay-explore.md" with { type: "file" };
import verify from "../../agents/relay-verify.md" with { type: "file" };
export const parseVersion = (s: string) => (s.match(/(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1, 4).map(Number);
export const versionOk = (s: string) => { const [a, b, c] = parseVersion(s); return a > 2 || (a === 2 && (b > 1 || (b === 1 && c >= 251))); };
export function tomlStringify(c: Config): string {
  const q = (v: unknown): string => (typeof v === "string" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(q).join(", ")}]` : v === null ? "" : String(v));
  const lines: string[] = [`port = ${c.port}`, `max_concurrent_agents = ${c.max_concurrent_agents}`, `claude_bin = ${q(c.claude_bin)}`, `path_prepend = ${q(c.path_prepend)}`, ""];
  const section = (name: string, obj: Record<string, unknown>) => { lines.push(`[${name}]`); for (const [k, v] of Object.entries(obj)) if (v !== null && typeof v !== "object") lines.push(`${k} = ${q(v)}`); else if (Array.isArray(v)) lines.push(`${k} = ${q(v)}`); lines.push(""); for (const [k, v] of Object.entries(obj)) if (v && typeof v === "object" && !Array.isArray(v)) section(`${name}.${k}`, v as Record<string, unknown>); };
  for (const k of ["dispatcher", "worker", "usage", "idle", "pool"] as const) section(k, c[k] as Record<string, unknown>);
  return lines.join("\n");
}
export function planAgentInstall(existing: Record<string, string | null>, bundled: Record<string, string>) { const out = { copy: [] as string[], same: [] as string[], differ: [] as string[] }; for (const [n, b] of Object.entries(bundled)) { const e = existing[n]; if (e == null) out.copy.push(n); else if (e === b) out.same.push(n); else out.differ.push(n); } return out; }
const ask = (q: string, d = "") => { if (process.env.RELAY_SETUP_YES) return d; const a = prompt(`${q}${d ? ` [${d}]` : ""}: `); return (a ?? "").trim() || d; };
const run = async (cmd: string[], env: Record<string, string> = {}) => { const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env, ANTHROPIC_API_KEY: undefined } as any }); const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]); return { code: await p.exited, out: o, err: e }; };
const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
export async function setup(rest: string[]) {
  if (has(rest, "--yes")) process.env.RELAY_SETUP_YES = "1"; ensureDirs(); const cfg = loadConfig(); const say = (s: string) => process.stdout.write(s + "\n");
  say("relay setup — 최초 설정 마법사\n");
  // ① claude CLI (+ PATH dirs launchd will need: the claude binary's own dir and node's dir for npm installs)
  const which = (await run(["sh", "-lc", "command -v claude"])).out.trim(); if (!which) { say("✖ claude CLI를 찾을 수 없습니다. https://code.claude.com/docs 설치 후 다시 실행하세요."); process.exitCode = 1; return; }
  cfg.claude_bin = resolve(which); const node = (await run(["sh", "-lc", "command -v node"])).out.trim();
  cfg.path_prepend = uniq([dirname(realpathSync(cfg.claude_bin)), dirname(cfg.claude_bin), node ? dirname(realpathSync(node)) : null]);
  const ver = (await run([cfg.claude_bin, "--version"])).out.trim(); if (!versionOk(ver)) { say(`✖ claude ${ver} — 2.1.251 이상이 필요합니다 (claude update)`); process.exitCode = 1; return; } say(`✔ claude ${ver} (${cfg.claude_bin}; PATH+ ${cfg.path_prepend.join(":")})`);
  const login = await run([cfg.claude_bin, "-p", "reply OK", "--tools", "", "--max-turns", "1", "--effort", "low", "--output-format", "json"]);   // never --bare: bare mode skips Keychain/OAuth
  if (login.code !== 0 || /"is_error":true/.test(login.out)) { say("✖ claude 로그인 상태가 아닙니다 — 터미널에서 `claude` 실행 후 /login 하세요."); process.exitCode = 1; return; } say("✔ CLI 로그인 확인");
  // ② API key guard
  if (process.env.ANTHROPIC_API_KEY) say("⚠ ANTHROPIC_API_KEY가 설정돼 있습니다 — relay는 서비스 환경에서 이를 제거합니다(구독 인증 사용).");
  // ③ service-context auth — only when the user will run relay under brew services (60s launchd probe)
  if (has(rest, "--service") || ask("brew services로 상시 구동할까요? (Y/n)", "Y").toLowerCase() !== "n") {
    const svc = await import("./doctor.ts").then((d) => d.serviceAuthProbe(cfg.claude_bin)); if (svc === "keychain") say("✔ launchd 서비스에서 Keychain 인증 OK");
    else { say("⚠ 서비스 컨텍스트에서 Keychain을 읽지 못했습니다. `claude setup-token`으로 장기 토큰을 만들고 붙여 넣으세요."); const tok = ask("CLAUDE_CODE_OAUTH_TOKEN (빈 값이면 건너뜀)"); if (tok) { writeFileSync(paths.oauthToken, tok + "\n", { mode: 0o600 }); say(`✔ ${paths.oauthToken} 저장 (0600)`); } }
  }
  // ④ config
  cfg.port = Number(ask("포트", String(cfg.port))); cfg.max_concurrent_agents = Number(ask("동시 실행 상한", String(cfg.max_concurrent_agents)));
  writeFileSync(paths.config, tomlStringify(ConfigSchema.parse(cfg)), { mode: 0o600 }); say(`✔ ${paths.config}`);
  // ⑤ projects — through the API when the server is up (one writer, WS projects.updated), straight into the DB otherwise
  const { registerProjectOffline } = await import("./db.ts"); const up = await client().up();
  for (;;) { const p = ask("등록할 프로젝트 경로 (빈 값이면 종료)"); if (!p) break; const path = resolve(p.replace(/^~/, process.env.HOME!)); if (!existsSync(path)) { say("  ✖ 경로 없음"); continue; }
    const isGit = (await run(["git", "-C", path, "rev-parse", "--is-inside-work-tree"])).code === 0; const name = ask("  이름", basename(path)); const description = ask("  설명", ""); const keywords = ask("  키워드(쉼표)", "").split(",").map((s) => s.trim()).filter(Boolean);
    const proj = { name, path, description, keywords, is_git: isGit }; if (up) await client().post("/projects", proj); else await registerProjectOffline(proj); say(`  ✔ ${name} (${isGit ? "git" : "non-git · 동시성 1"})`); }
  // ⑥ agents
  mkdirSync(paths.agentsDir, { recursive: true }); const bundled: Record<string, string> = { "relay-worker.md": await Bun.file(worker).text(), "relay-explore.md": await Bun.file(explore).text(), "relay-verify.md": await Bun.file(verify).text() };
  const existing = Object.fromEntries(Object.keys(bundled).map((n) => [n, existsSync(join(paths.agentsDir, n)) ? readFileSync(join(paths.agentsDir, n), "utf8") : null]));
  const plan = planAgentInstall(existing, bundled); for (const n of plan.copy) writeFileSync(join(paths.agentsDir, n), bundled[n]); for (const n of plan.differ) { if (ask(`  ${n}이(가) 번들과 다릅니다. 덮어쓸까요? (y/N)`, "N").toLowerCase() === "y") writeFileSync(join(paths.agentsDir, n), bundled[n]); }
  say(`✔ 에이전트 정의: 설치 ${plan.copy.length} · 동일 ${plan.same.length} · 유지 ${plan.differ.length} (${paths.agentsDir}, /agents로 편집 가능)`);
  // ⑦ MCP — registered with the opt path (survives brew upgrade), argv-safe for paths with spaces
  const hasMcp = (await run([cfg.claude_bin, "mcp", "get", "relay"])).code === 0; if (!hasMcp) { const r = await run([cfg.claude_bin, "mcp", "add", "--scope", "user", "relay", "--", ...relayArgv(), "mcp"]); say(r.code === 0 ? "✔ MCP 서버 relay 등록(user scope)" : `⚠ MCP 등록 실패: ${r.err.slice(0, 200)}`); } else say("✔ MCP 서버 relay 이미 등록됨");
  // ⑧ capabilities — the probe only (doctor() is a CLI entry point that exits)
  if (!existsSync(paths.capabilities)) { say("… capability 검사(--bg spawn/stop/resume, 약 1분)"); const d = await import("./doctor.ts"); say(d.summarize([await d.probeCapabilities(cfg.claude_bin)])); }
  say("\n완료. 다음 단계:\n  brew services start relay\n  relay open");
}
