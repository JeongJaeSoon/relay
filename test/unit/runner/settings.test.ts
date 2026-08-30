import { expect, test } from "bun:test";
import { buildSettingsJson, relayBin, workerEnv } from "../../../src/runner/settings.ts";

test("settings json injects every observation hook, deny rules and inbound accept", () => {
  const s = JSON.parse(buildSettingsJson({ port: 8790, allowPush: false, maxAgents: 10, bin: "/opt/homebrew/bin/relay" }));
  expect(s.crossSessionInbound).toBe("accept");
  for (const e of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied", "SubagentStart", "SubagentStop", "Notification", "Stop", "SessionEnd", "WorktreeRemove"]) expect(s.hooks[e]).toBeDefined();
  expect(s.hooks.WorktreeCreate).toBeUndefined();   // provider hook: registering it aborts session init (Phase 0)
  expect(s.hooks.SessionStart[0].hooks[0].type).toBe("command");
  expect(s.hooks.PreToolUse.find((h: any) => h.matcher === "Agent").hooks[0].url).toBe("http://127.0.0.1:8790/api/hooks");
  expect(s.hooks.PreToolUse.find((h: any) => h.matcher === "Bash|Edit|Write|MultiEdit|NotebookEdit").hooks[0].command).toBe("/opt/homebrew/bin/relay hook guard");
  expect(s.hooks.SessionStart[0].hooks[0].command).toBe("/opt/homebrew/bin/relay hook SessionStart");
  expect(s.hooks.Stop[0].hooks[0].headers.Authorization).toBe("Bearer $RELAY_HOOK_TOKEN"); expect(s.hooks.Stop[0].hooks[0].allowedEnvVars).toEqual(["RELAY_HOOK_TOKEN", "RELAY_TASK_UUID", "RELAY_GEN"]); expect(s.hooks.Stop[0].hooks[0].headers["X-Relay-Gen"]).toBe("$RELAY_GEN");
  expect(s.hooks.Stop[0].hooks[0].headers["X-Relay-Task"]).toBe("$RELAY_TASK_UUID"); expect(s.hooks.Stop[0].hooks[0].timeout).toBe(3);
  expect(s.hooks.PermissionRequest[0].hooks[0].timeout).toBe(900);   // held open until the user approves in the dashboard (Task 8)
  expect(s.permissions.deny).toContain("Bash(git push*)"); expect(s.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe("1"); expect(s.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe("10");
  expect(JSON.parse(buildSettingsJson({ port: 1, allowPush: true, maxAgents: 1 })).permissions.deny).not.toContain("Bash(git push*)");
});
test("relayBin takes RELAY_BIN verbatim and quotes spaces", () => {
  const saved = process.env.RELAY_BIN;
  process.env.RELAY_BIN = "/opt/homebrew/Cellar/relay/0.1.0/bin/relay"; expect(relayBin()).toBe("/opt/homebrew/Cellar/relay/0.1.0/bin/relay");   // RELAY_BIN is taken verbatim (brew service sets it to opt_bin)
  process.env.RELAY_BIN = "/Users/me/My Apps/relay"; expect(relayBin()).toBe('"/Users/me/My Apps/relay"');
  if (saved === undefined) delete process.env.RELAY_BIN; else process.env.RELAY_BIN = saved;
});
test("worker env is an allowlist without ANTHROPIC_API_KEY", () => {
  const savedPath = process.env.PATH;
  process.env.ANTHROPIC_API_KEY = "leak"; process.env.PATH = "/bin";
  const e = workerEnv({ taskUuid: "u", port: 8790, hookToken: "H", oauthToken: null, maxAgents: 3 });
  expect(e.ANTHROPIC_API_KEY).toBeUndefined(); expect(e.PATH).toBe("/bin"); expect(e.RELAY_TASK_UUID).toBe("u"); expect(e.RELAY_HOOK_TOKEN).toBe("H"); expect(e.RELAY_API_URL).toBe("http://127.0.0.1:8790");
  delete process.env.ANTHROPIC_API_KEY; if (savedPath !== undefined) process.env.PATH = savedPath;
});
