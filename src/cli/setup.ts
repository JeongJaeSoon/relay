// src/cli/setup.ts — first-run wizard (§18): claude CLI, service auth, config, projects, agent definitions, MCP, capabilities.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, type Dirent } from "node:fs";
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
/** git repos under `root`, nearest first. Depth 2 covers both `~/workspace/repo` and `~/workspace/project/repo`.
 *  `.git` is a file in a worktree and a directory in a clone, so existence is the test. */
export function discoverRepos(root: string, maxDepth = 2): string[] {
  const skip = (n: string) => n.startsWith(".") || n === "node_modules" || n === "dist" || n === "target";
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: Dirent[]; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || skip(e.name)) continue;
      const child = join(dir, e.name);
      if (existsSync(join(child, ".git"))) out.push(child);             // a repo is a leaf: never descend into one
      else if (depth < maxDepth) walk(child, depth + 1);
    }
  };
  walk(root, 1);
  return out.sort();                                                       // discovery order is filesystem order; the list is read by a human
}
/** "all" | "1,3" | "2-5" | "" → zero-based indices, deduped, in order, out-of-range dropped. */
export function parseSelection(input: string, count: number): number[] {
  const t = input.trim().toLowerCase();
  if (!t) return [];
  if (t === "all") return [...Array(count).keys()];
  const picked = new Set<number>();
  for (const part of t.split(",")) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/); if (!m) continue;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= count) picked.add(i - 1);
  }
  return [...picked].sort((x, y) => x - y);
}
const ask = (q: string, d = "") => { if (process.env.RELAY_SETUP_YES) return d; const a = prompt(`${q}${d ? ` [${d}]` : ""}: `); return (a ?? "").trim() || d; };
const run = async (cmd: string[], env: Record<string, string> = {}) => { const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env, ANTHROPIC_API_KEY: undefined } as any }); const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]); return { code: await p.exited, out: o, err: e }; };
const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
export async function setup(rest: string[]) {
  if (has(rest, "--yes")) process.env.RELAY_SETUP_YES = "1"; ensureDirs(); const cfg = loadConfig(); const say = (s: string) => process.stdout.write(s + "\n");
  say("relay setup — first-run wizard\n");
  // ① claude CLI (+ PATH dirs launchd will need: the claude binary's own dir and node's dir for npm installs)
  const which = (await run(["sh", "-lc", "command -v claude"])).out.trim(); if (!which) { say("✖ claude CLI not found. Install it from https://code.claude.com/docs and run this again."); process.exitCode = 1; return; }
  cfg.claude_bin = resolve(which); const node = (await run(["sh", "-lc", "command -v node"])).out.trim();
  cfg.path_prepend = uniq([dirname(realpathSync(cfg.claude_bin)), dirname(cfg.claude_bin), node ? dirname(realpathSync(node)) : null]);
  const ver = (await run([cfg.claude_bin, "--version"])).out.trim(); if (!versionOk(ver)) { say(`✖ claude ${ver} — 2.1.251 or newer is required (claude update)`); process.exitCode = 1; return; } say(`✔ claude ${ver} (${cfg.claude_bin}; PATH+ ${cfg.path_prepend.join(":")})`);
  const login = await run([cfg.claude_bin, "-p", "reply OK", "--tools", "", "--max-turns", "1", "--effort", "low", "--output-format", "json"]);   // never --bare: bare mode skips Keychain/OAuth
  if (login.code !== 0 || /"is_error":true/.test(login.out)) { say("✖ claude is not logged in — run `claude` in a terminal, then /login."); process.exitCode = 1; return; } say("✔ CLI login confirmed");
  // ② API key guard
  if (process.env.ANTHROPIC_API_KEY) say("⚠ ANTHROPIC_API_KEY is set — relay strips it in the service environment (it uses subscription auth).");
  // ③ service-context auth — only when the user will run relay under brew services (60s launchd probe)
  if (has(rest, "--service") || ask("Run relay permanently via brew services? (Y/n)", "Y").toLowerCase() !== "n") {
    const svc = await import("./doctor.ts").then((d) => d.serviceAuthProbe(cfg.claude_bin)); if (svc === "keychain") say("✔ Keychain auth works in the launchd service");
    else { say("⚠ Could not read the Keychain in the service context. Create a long-lived token with `claude setup-token` and paste it here."); const tok = ask("CLAUDE_CODE_OAUTH_TOKEN (blank to skip)"); if (tok) { writeFileSync(paths.oauthToken, tok + "\n", { mode: 0o600 }); say(`✔ saved ${paths.oauthToken} (0600)`); } }
  }
  // ④ config
  cfg.port = Number(ask("Port", String(cfg.port))); cfg.max_concurrent_agents = Number(ask("Max concurrent agents", String(cfg.max_concurrent_agents)));
  writeFileSync(paths.config, tomlStringify(ConfigSchema.parse(cfg)), { mode: 0o600 }); say(`✔ ${paths.config}`);
  // ⑤ projects — through the API when the server is up (one writer, WS projects.updated), straight into the DB otherwise
  const { registerProjectOffline } = await import("./db.ts"); const up = await client().up();
  const register = async (proj: { name: string; path: string; description: string; keywords: string[]; is_git: boolean }) => {
    if (up) await client().post("/projects", proj); else await registerProjectOffline(proj);
    say(`  ✔ ${proj.name} (${proj.is_git ? "git" : "non-git · concurrency 1"})`);
  };
  for (;;) { const p = ask("Project path to register (blank to finish)"); if (!p) break; const path = resolve(p.replace(/^~/, process.env.HOME!)); if (!existsSync(path)) { say("  ✖ no such path"); continue; }
    const isGit = (await run(["git", "-C", path, "rev-parse", "--is-inside-work-tree"])).code === 0;
    if (!isGit) {
      // A parent directory is the natural thing to type. Registering it as one project would put every repo under it
      // inside a single non-git project — no worktree isolation, and the guard boundary widened to the whole tree.
      const repos = discoverRepos(path);
      if (repos.length) {
        say(`  This path is not a git repository. Found ${repos.length} repositories under it:`);
        repos.forEach((r, i) => say(`    ${String(i + 1).padStart(2)}) ${basename(r).padEnd(24)} ${r.replace(process.env.HOME!, "~")}`));
        say("  Registered projects become routing candidates for the dispatcher — pick only the ones you want relay to handle.");
        const picks = parseSelection(ask("  Numbers to register (comma/range, all, blank to skip)"), repos.length);
        for (const i of picks) await register({ name: basename(repos[i]), path: repos[i], description: "", keywords: [], is_git: true });
        if (!picks.length) say("  Skipped (descriptions and keywords can be filled in from the dashboard settings panel)");
        continue;
      }
      say("  ⚠ Not a git repository, and none underneath. Registered as is, work happens directly in this directory with no worktree isolation, and the guard boundary widens to the whole directory.");
      if (ask("  Register it anyway? (y/N)", "N").toLowerCase() !== "y") continue;
    }
    const name = ask("  Name", basename(path)); const description = ask("  Description", ""); const keywords = ask("  Keywords (comma-separated)", "").split(",").map((s) => s.trim()).filter(Boolean);
    await register({ name, path, description, keywords, is_git: isGit }); }
  // ⑥ agents
  mkdirSync(paths.agentsDir, { recursive: true }); const bundled: Record<string, string> = { "relay-worker.md": await Bun.file(worker).text(), "relay-explore.md": await Bun.file(explore).text(), "relay-verify.md": await Bun.file(verify).text() };
  const existing = Object.fromEntries(Object.keys(bundled).map((n) => [n, existsSync(join(paths.agentsDir, n)) ? readFileSync(join(paths.agentsDir, n), "utf8") : null]));
  const plan = planAgentInstall(existing, bundled); for (const n of plan.copy) writeFileSync(join(paths.agentsDir, n), bundled[n]); for (const n of plan.differ) { if (ask(`  ${n} differs from the bundled copy. Overwrite? (y/N)`, "N").toLowerCase() === "y") writeFileSync(join(paths.agentsDir, n), bundled[n]); }
  say(`✔ Agent definitions: installed ${plan.copy.length} · unchanged ${plan.same.length} · kept ${plan.differ.length} (${paths.agentsDir}, editable with /agents)`);
  // ⑦ MCP — registered with the opt path (survives brew upgrade), argv-safe for paths with spaces
  const hasMcp = (await run([cfg.claude_bin, "mcp", "get", "relay"])).code === 0; if (!hasMcp) { const r = await run([cfg.claude_bin, "mcp", "add", "--scope", "user", "relay", "--", ...relayArgv(), "mcp"]); say(r.code === 0 ? "✔ MCP server relay registered (user scope)" : `⚠ MCP registration failed: ${r.err.slice(0, 200)}`); } else say("✔ MCP server relay already registered");
  // ⑧ capabilities — the probe only (doctor() is a CLI entry point that exits)
  if (!existsSync(paths.capabilities)) { say("… capability probe (--bg spawn/stop/resume, about a minute)"); const d = await import("./doctor.ts"); say(d.summarize([await d.probeCapabilities(cfg.claude_bin)])); }
  say("\nDone. Next:\n  brew services start relay\n  relay open");
}
