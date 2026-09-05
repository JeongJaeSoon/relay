import { INJECTED_HOOK_EVENTS } from "../hooks/ingest.ts";

// These observations change process/task lifetime and must survive an unavailable gateway.
// Decision hooks stay HTTP: a replay cannot authorize a tool call or answer a live permission prompt.
const DURABLE_HOOK_EVENTS = new Set(["SessionStart", "SubagentStart", "SubagentStop", "Stop", "SessionEnd"]);

const q = (a: string) => (/[\s"']/.test(a) ? JSON.stringify(a) : a);
/** relay binary for command hooks (shell-quoted): absolute so launchd's minimal PATH cannot break SessionStart/guard hooks (roadmap §7).
 *  A compiled binary's execPath resolves symlinks to the versioned Cellar path — map it back to <prefix>/bin/relay so `brew upgrade` does not orphan hooks. */
export const relayBin = () => {
  if (process.env.RELAY_BIN) return q(process.env.RELAY_BIN);
  const exe = process.execPath; if (/\/bun$/.test(exe)) return `${q(exe)} ${q(process.argv[1] ?? "")}`;
  const m = exe.match(/^(.*)\/Cellar\/relay\/[^/]+\/bin\/relay$/); return q(m ? `${m[1]}/bin/relay` : exe);
};

/** Per-spawn settings. The task uuid, its hook token and the generation nonce are baked in as LITERAL values, not as
 *  `$RELAY_*` env references: measured 2026-08-31, a `claude --bg` session is started by the supervisor daemon and does
 *  NOT inherit the environment of the `claude --bg` invocation, so every env-interpolated header arrived empty and every
 *  hook was rejected with 401. The command hooks take the same values as arguments for the same reason. */
export function buildSettingsJson(p: { port: number; allowPush: boolean; maxAgents: number; bin?: string; taskUuid?: string; hookToken?: string; gen?: number; home?: string }): string {
  const bin = p.bin ?? relayBin();
  const api = `http://127.0.0.1:${p.port}`;
  const task = p.taskUuid ?? ""; const gen = String(p.gen ?? 0);
  const http = { type: "http", url: `${api}/api/hooks`, headers: { Authorization: `Bearer ${p.hookToken ?? ""}`, "X-Relay-Task": task, "X-Relay-Gen": gen }, timeout: 3 };
  const cmdArgs = ` --task ${q(task)} --gen ${gen} --url ${q(api)}${p.home ? ` --home ${q(p.home)}` : ""}`;
  const hooks: Record<string, unknown> = {};
  for (const e of INJECTED_HOOK_EVENTS) hooks[e] = DURABLE_HOOK_EVENTS.has(e) ? [{ hooks: [{ type: "command", command: `${bin} hook ${e}${cmdArgs}`, timeout: 5 }] }] : [{ hooks: [http] }];
  hooks.PermissionRequest = [{ hooks: [{ ...http, timeout: 900 }] }];   // relay answers when the user clicks Allow/Deny (auto-deny after 14 min)
  hooks.PreToolUse = [
    { matcher: "Agent", hooks: [http] },
    { matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: `${bin} hook guard${cmdArgs}${p.allowPush ? " --allow-push" : ""}`, timeout: 5 }] },
    { hooks: [http] },
  ];
  // Edit(...) rules cover every file-editing tool; a Write(path) rule is not matched by file permission checks at all
  // (the CLI warns about it on stderr), so the path guards are expressed as Edit/Read.
  const deny = ["Bash(sudo *)", "Bash(rm -rf /*)", "Edit(~/.claude/**)", "Edit(~/.config/relay/**)", "Read(~/.config/relay/**)"];
  if (!p.allowPush) deny.unshift("Bash(git push*)");
  return JSON.stringify({ crossSessionInbound: "accept", env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1", CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(p.maxAgents) }, permissions: { deny }, hooks });
}

const PASS = ["PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM"];
/** Environment for the `claude` process relay launches. NOTE: a `--bg` session does not inherit this (the supervisor
 *  daemon owns it), so the RELAY_* values here only reach non-bg invocations — the worker's hooks get them from
 *  buildSettingsJson instead. `claude` itself still needs PATH/HOME and the OAuth fallback token. */
export function workerEnv(p: { taskUuid: string; port: number; hookToken: string; oauthToken: string | null; maxAgents: number; gen?: number }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS) if (process.env[k]) env[k] = process.env[k]!;
  if (p.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = p.oauthToken;
  env.RELAY_TASK_UUID = p.taskUuid; env.RELAY_API_URL = `http://127.0.0.1:${p.port}`; env.RELAY_HOOK_TOKEN = p.hookToken; env.RELAY_GEN = String(p.gen ?? 0);
  env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = "1"; env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = String(p.maxAgents);
  return env;
}
