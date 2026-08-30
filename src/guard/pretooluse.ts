// src/guard/pretooluse.ts — `relay hook guard`: the realpath boundary the `permissions.deny` patterns cannot express (B8).
import { realpathSync, existsSync } from "node:fs";
import { dirname, basename, resolve, join } from "node:path";
import { homedir } from "node:os";
const HOME = homedir();
function realish(p: string, cwd: string): string { const abs = resolve(cwd, p.replace(/^~(?=\/|$)/, HOME)); if (existsSync(abs)) return realpathSync(abs); let dir = dirname(abs); const parts: string[] = [basename(abs)]; while (!existsSync(dir) && dir !== dirname(dir)) { parts.unshift(basename(dir)); dir = dirname(dir); } return join(realpathSync(dir), ...parts); }
const inside = (p: string, root: string) => { const r = realpathSync(root); return p === r || p.startsWith(r + "/"); };
const PROTECTED = [join(HOME, ".claude"), join(HOME, ".config", "relay"), join(HOME, ".ssh"), join(HOME, ".aws")];
export function guardDecision(body: any, env: { cwd: string; RELAY_ALLOW_PUSH?: string }): { block: boolean; reason: string } {
  const tool = String(body.tool_name ?? ""); const input = body.tool_input ?? {};
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const target = realish(String(input.file_path ?? input.notebook_path ?? ""), env.cwd);
    if (PROTECTED.some((d) => existsSync(d) && inside(target, d))) return { block: true, reason: `relay guard: protected path ${target}` };
    if (!inside(target, env.cwd)) return { block: true, reason: `relay guard: write outside worktree (${target})` };
    return { block: false, reason: "" };
  }
  if (tool === "Bash") {
    const cmd = String(input.command ?? "");
    if (/\bgit\s+push\b/.test(cmd) && env.RELAY_ALLOW_PUSH !== "1") return { block: true, reason: "relay guard: git push is disabled for this task (opt-in in relay config)" };
    if (/(^|[;&|]\s*)sudo\b/.test(cmd)) return { block: true, reason: "relay guard: sudo" };
    if (/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)[a-zA-Z]*\s+(\/|~)/.test(cmd)) return { block: true, reason: "relay guard: rm -rf on an absolute or home path" };
    if (/curl[^|]*\|\s*(sh|bash|zsh)\b/.test(cmd) || /wget[^|]*\|\s*(sh|bash)\b/.test(cmd)) return { block: true, reason: "relay guard: piping downloads into a shell" };
    if (/(~|\$HOME|\/Users\/[^/ ]+)\/(\.claude|\.config\/relay|\.ssh|\.aws)\b/.test(cmd)) return { block: true, reason: "relay guard: protected directory" };
    const redirect = cmd.match(/(?:^|[^<>])>{1,2}\s*("?)(\/[^\s"]+)\1/); if (redirect && !inside(realish(redirect[2], env.cwd), env.cwd)) return { block: true, reason: `relay guard: redirect outside worktree (${redirect[2]})` };
    return { block: false, reason: "" };
  }
  return { block: false, reason: "" };
}
/** Entry point for `relay hook guard`: stdin JSON → exit 2 (block) / 0 (allow). Any failure blocks (fail-closed). */
export async function runGuard(): Promise<never> {
  try {
    const body = JSON.parse(await new Response(Bun.stdin.stream()).text());
    const d = guardDecision(body, { cwd: String(body.cwd ?? process.cwd()), RELAY_ALLOW_PUSH: process.env.RELAY_ALLOW_PUSH });
    if (d.block) { process.stderr.write(d.reason + "\n"); process.exit(2); }
    process.exit(0);
  } catch (e) { process.stderr.write(`relay guard error (blocking): ${String(e)}\n`); process.exit(2); }
}
