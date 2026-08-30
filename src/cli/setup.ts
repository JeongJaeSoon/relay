// src/cli/setup.ts — first-run wizard (§18): claude CLI, service auth, config, projects, agent definitions, MCP, capabilities.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, type Dirent } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import * as p from "@clack/prompts";
import { ConfigSchema, loadConfig, paths, ensureDirs, type Config } from "../config.ts";
import { client, relayArgv, has } from "./client.ts";
import worker from "../../agents/relay-worker.md" with { type: "file" };     // embedded straight from the source files (bun build --compile)
import explore from "../../agents/relay-explore.md" with { type: "file" };
import verify from "../../agents/relay-verify.md" with { type: "file" };
import { driftWarns, loadCapabilities, showVersion, versionDrift, versionOk } from "../runner/capabilities.ts";
export { parseVersion, versionOk } from "../runner/capabilities.ts";          // they live there because serve.ts needs them and must not import this module
/** Why the wizard should spend a probe, or null for "not now". `relay setup` after a `claude update` is the obvious
 *  thing to do, and gating the probe on the file merely existing left those measurements stale for good. Probing
 *  stays here, in the wizard the user chose to run: it spawns a real background session and about a minute of
 *  subscription usage, which is never something a `serve` or a plain `doctor` should decide to spend. */
export const probeReason = (hasCapabilities: boolean, recorded: string, current: string): "missing" | "drift" | null =>
  !hasCapabilities ? "missing" : driftWarns(versionDrift(recorded, current)) ? "drift" : null;
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
// @clack/prompts blocks forever on a non-TTY stdin (measured), and setup runs unattended under `--yes` and in CI,
// so every prompt goes through these: no TTY or --yes means take the default and never render a prompt.
const interactive = () => !process.env.RELAY_SETUP_YES && process.stdin.isTTY === true;
const bail = (): never => { p.cancel("setup cancelled"); process.exit(130); };
const askText = async (message: string, initialValue = "") => {
  if (!interactive()) return initialValue;
  const v = await p.text({ message, placeholder: initialValue, defaultValue: initialValue });
  if (p.isCancel(v)) bail();
  return String(v ?? "").trim() || initialValue;
};
const askConfirm = async (message: string, initialValue: boolean) => {
  if (!interactive()) return initialValue;
  const v = await p.confirm({ message, initialValue });
  if (p.isCancel(v)) bail();
  return v as boolean;
};
const askRepos = async (message: string, repos: string[]) => {
  if (!interactive()) return [];
  const v = await p.multiselect<string>({ message, required: false,
    options: repos.map((r) => ({ value: r, label: basename(r), hint: r.replace(process.env.HOME!, "~") })) });
  if (p.isCancel(v)) bail();
  return (v ?? []) as string[];
};
/** A spinner is only honest on a TTY; elsewhere it is a log line. */
const withSpinner = async <T>(message: string, fn: () => Promise<T>, done: (r: T) => string): Promise<T> => {
  if (!interactive()) { p.log.info(message); const r = await fn(); p.log.success(done(r)); return r; }
  const sp = p.spinner(); sp.start(message); const r = await fn(); sp.stop(done(r)); return r;
};
const run = async (cmd: string[], env: Record<string, string> = {}) => { const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env, ANTHROPIC_API_KEY: undefined } as any }); const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]); return { code: await p.exited, out: o, err: e }; };
const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
export async function setup(rest: string[]) {
  if (has(rest, "--yes")) process.env.RELAY_SETUP_YES = "1"; ensureDirs(); const cfg = loadConfig();
  p.intro("relay setup");
  // ① claude CLI (+ PATH dirs launchd will need: the claude binary's own dir and node's dir for npm installs)
  const which = (await run(["sh", "-lc", "command -v claude"])).out.trim(); if (!which) { p.log.error("claude CLI not found. Install it from https://code.claude.com/docs and run this again."); p.outro("stopped"); process.exitCode = 1; return; }
  cfg.claude_bin = resolve(which); const node = (await run(["sh", "-lc", "command -v node"])).out.trim();
  cfg.path_prepend = uniq([dirname(realpathSync(cfg.claude_bin)), dirname(cfg.claude_bin), node ? dirname(realpathSync(node)) : null]);
  const ver = (await run([cfg.claude_bin, "--version"])).out.trim(); if (!versionOk(ver)) { p.log.error(`claude ${ver} — 2.1.251 or newer is required (claude update)`); p.outro("stopped"); process.exitCode = 1; return; } p.log.success(`claude ${ver}  ${cfg.claude_bin}`);
  const login = await run([cfg.claude_bin, "-p", "reply OK", "--tools", "", "--max-turns", "1", "--effort", "low", "--output-format", "json"]);   // never --bare: bare mode skips Keychain/OAuth
  if (login.code !== 0 || /"is_error":true/.test(login.out)) { p.log.error("claude is not logged in — run `claude` in a terminal, then /login."); p.outro("stopped"); process.exitCode = 1; return; } p.log.success("CLI login confirmed");
  // ② API key guard
  if (process.env.ANTHROPIC_API_KEY) p.log.warn("ANTHROPIC_API_KEY is set — relay strips it in the service environment (it uses subscription auth).");
  // ③ service-context auth — only when the user will run relay under brew services (60s launchd probe)
  if (has(rest, "--service") || await askConfirm("Run relay permanently via brew services?", true)) {
    const svc = await withSpinner("Checking Keychain auth in the launchd service (up to 60s)",
      () => import("./doctor.ts").then((d) => d.serviceAuthProbe(cfg.claude_bin)),
      (r) => r === "keychain" ? "Keychain auth works in the launchd service" : "Keychain unavailable in the service context");
    if (svc !== "keychain") {
      p.log.warn("Create a long-lived token with `claude setup-token` and paste it here.");
      const tok = await askText("CLAUDE_CODE_OAUTH_TOKEN (blank to skip)");
      if (tok) { writeFileSync(paths.oauthToken, tok + "\n", { mode: 0o600 }); p.log.success(`saved ${paths.oauthToken} (0600)`); }
    }
  }
  // ④ config
  cfg.port = Number(await askText("Port", String(cfg.port))); cfg.max_concurrent_agents = Number(await askText("Max concurrent agents", String(cfg.max_concurrent_agents)));
  writeFileSync(paths.config, tomlStringify(ConfigSchema.parse(cfg)), { mode: 0o600 }); p.log.success(paths.config);
  // ⑤ projects — through the API when the server is up (one writer, WS projects.updated), straight into the DB otherwise
  const { registerProjectOffline } = await import("./db.ts"); const up = await client().up();
  const register = async (proj: { name: string; path: string; description: string; keywords: string[]; is_git: boolean }) => {
    if (up) await client().post("/projects", proj); else await registerProjectOffline(proj);
    p.log.success(`${proj.name}  ${proj.path.replace(process.env.HOME!, "~")}`);
  };
  for (;;) { const entered = await askText("Project path to register (blank to finish)"); if (!entered) break;
    const path = resolve(entered.replace(/^~/, process.env.HOME!)); if (!existsSync(path)) { p.log.error("no such path"); continue; }
    if ((await run(["git", "-C", path, "rev-parse", "--is-inside-work-tree"])).code === 0) {
      const name = await askText("Name", basename(path)); const description = await askText("Description", "");
      const keywords = (await askText("Keywords (comma-separated)", "")).split(",").map((s) => s.trim()).filter(Boolean);
      await register({ name, path, description, keywords, is_git: true }); continue;
    }
    // A parent directory is the natural thing to type, and it is not a valid root: a project root must be a repository,
    // which is what gives each task its own worktree and bounds the guard. So offer what is underneath instead.
    const repos = discoverRepos(path);
    if (!repos.length) { p.log.error("Not a git repository, and none underneath. A project root must be a git repository."); continue; }
    p.log.info("Every registered project is a routing candidate for the dispatcher — pick only what relay should work on.");
    const picked = await askRepos(`Not a repository. ${repos.length} found underneath — which should relay work on?`, repos);
    for (const r of picked) await register({ name: basename(r), path: r, description: "", keywords: [], is_git: true });
    if (!picked.length) p.log.info("Nothing selected (descriptions and keywords can be filled in from the dashboard settings panel)");
  }
  // ⑥ agents
  mkdirSync(paths.agentsDir, { recursive: true }); const bundled: Record<string, string> = { "relay-worker.md": await Bun.file(worker).text(), "relay-explore.md": await Bun.file(explore).text(), "relay-verify.md": await Bun.file(verify).text() };
  const existing = Object.fromEntries(Object.keys(bundled).map((n) => [n, existsSync(join(paths.agentsDir, n)) ? readFileSync(join(paths.agentsDir, n), "utf8") : null]));
  const plan = planAgentInstall(existing, bundled); for (const n of plan.copy) writeFileSync(join(paths.agentsDir, n), bundled[n]);
  for (const n of plan.differ) { if (await askConfirm(`${n} differs from the bundled copy. Overwrite?`, false)) writeFileSync(join(paths.agentsDir, n), bundled[n]); }
  p.log.success(`Agent definitions: installed ${plan.copy.length} · unchanged ${plan.same.length} · kept ${plan.differ.length}  (${paths.agentsDir}, editable with /agents)`);
  // ⑦ MCP — registered with the opt path (survives brew upgrade), argv-safe for paths with spaces
  const hasMcp = (await run([cfg.claude_bin, "mcp", "get", "relay"])).code === 0;
  if (!hasMcp) { const r = await run([cfg.claude_bin, "mcp", "add", "--scope", "user", "relay", "--", ...relayArgv(), "mcp"]); if (r.code === 0) p.log.success("MCP server relay registered (user scope)"); else p.log.warn(`MCP registration failed: ${r.err.slice(0, 200)}`); }
  else p.log.success("MCP server relay already registered");
  // ⑧ capabilities — the probe only (doctor() is a CLI entry point that exits)
  const caps = loadCapabilities(); const reason = probeReason(existsSync(paths.capabilities), caps.cli_version, ver);
  if (reason) {
    const d = await import("./doctor.ts");
    const why = reason === "drift"
      ? `Re-probing capabilities: claude moved ${showVersion(caps.cli_version)} → ${showVersion(ver)} since they were measured`
      : "Probing capabilities";
    const c = await withSpinner(`${why} — spawns one background session (about a minute)`,
      () => d.probeCapabilities(cfg.claude_bin), (r) => `capabilities — ${r.detail}`);
    if (!c.ok && c.fix) p.log.warn(c.fix);
  }
  p.outro("Done.  brew services start relay  ·  relay open");
}
