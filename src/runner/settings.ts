import { INJECTED_HOOK_EVENTS } from "../hooks/ingest.ts";

const q = (a: string) => (/[\s"']/.test(a) ? JSON.stringify(a) : a);
/** relay binary for command hooks (shell-quoted): absolute so launchd's minimal PATH cannot break SessionStart/guard hooks (roadmap §7).
 *  A compiled binary's execPath resolves symlinks to the versioned Cellar path — map it back to <prefix>/bin/relay so `brew upgrade` does not orphan hooks. */
export const relayBin = () => {
  if (process.env.RELAY_BIN) return q(process.env.RELAY_BIN);
  const exe = process.execPath; if (/\/bun$/.test(exe)) return `${q(exe)} ${q(process.argv[1] ?? "")}`;
  const m = exe.match(/^(.*)\/Cellar\/relay\/[^/]+\/bin\/relay$/); return q(m ? `${m[1]}/bin/relay` : exe);
};

export function buildSettingsJson(p: { port: number; allowPush: boolean; maxAgents: number; bin?: string }): string {
  const bin = p.bin ?? relayBin();
  const http = { type: "http", url: `http://127.0.0.1:${p.port}/api/hooks`, headers: { Authorization: "Bearer $RELAY_HOOK_TOKEN", "X-Relay-Task": "$RELAY_TASK_UUID", "X-Relay-Gen": "$RELAY_GEN" }, allowedEnvVars: ["RELAY_HOOK_TOKEN", "RELAY_TASK_UUID", "RELAY_GEN"], timeout: 3 };
  const hooks: Record<string, unknown> = {};
  for (const e of INJECTED_HOOK_EVENTS) hooks[e] = e === "SessionStart" ? [{ hooks: [{ type: "command", command: `${bin} hook SessionStart`, timeout: 3 }] }] : [{ hooks: [http] }];
  hooks.PermissionRequest = [{ hooks: [{ ...http, timeout: 900 }] }];   // relay answers when the user clicks 허용/거부 (auto-deny after 14 min)
  hooks.PreToolUse = [
    { matcher: "Agent", hooks: [http] },
    { matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: `${bin} hook guard`, timeout: 5 }] },
    { hooks: [http] },
  ];
  const deny = ["Bash(sudo *)", "Bash(rm -rf /*)", "Write(~/.claude/**)", "Edit(~/.claude/**)", "Write(~/.config/relay/**)", "Edit(~/.config/relay/**)", "Read(~/.config/relay/**)"];
  if (!p.allowPush) deny.unshift("Bash(git push*)");
  return JSON.stringify({ crossSessionInbound: "accept", env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1", CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(p.maxAgents) }, permissions: { deny }, hooks });
}

const PASS = ["PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM"];
/** hookToken = per-task HMAC (auth.ts hookTokenFor); gen = the process generation relay assigned to this spawn/resume (hooks echo it as X-Relay-Gen). */
export function workerEnv(p: { taskUuid: string; port: number; hookToken: string; oauthToken: string | null; maxAgents: number; gen?: number }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS) if (process.env[k]) env[k] = process.env[k]!;
  if (p.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = p.oauthToken;
  env.RELAY_TASK_UUID = p.taskUuid; env.RELAY_API_URL = `http://127.0.0.1:${p.port}`; env.RELAY_HOOK_TOKEN = p.hookToken; env.RELAY_GEN = String(p.gen ?? 0);
  env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = "1"; env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = String(p.maxAgents);
  return env;
}
