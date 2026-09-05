import { expect, test } from "bun:test";
import { buildSettingsJson, relayBin, workerEnv } from "../../../src/runner/settings.ts";

test("settings json injects every observation hook, deny rules and inbound accept", () => {
  const s = JSON.parse(buildSettingsJson({ port: 8790, allowPush: false, maxAgents: 10, bin: "/opt/homebrew/bin/relay", taskUuid: "task-1", hookToken: "HT", gen: 4, home: "/home/relay" }));
  expect(s.crossSessionInbound).toBe("accept");
  for (const e of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied", "SubagentStart", "SubagentStop", "Notification", "Stop", "SessionEnd", "WorktreeRemove"]) expect(s.hooks[e]).toBeDefined();
  expect(s.hooks.WorktreeCreate).toBeUndefined();   // provider hook: registering it aborts session init (Phase 0)
  expect(s.hooks.SessionStart[0].hooks[0].type).toBe("command");
  expect(s.hooks.PreToolUse.find((h: any) => h.matcher === "Agent").hooks[0].url).toBe("http://127.0.0.1:8790/api/hooks");
  // literal values, not $RELAY_* env references: a `--bg` session is started by the supervisor daemon and inherits none of relay's environment (measured 2026-08-31)
  expect(s.hooks.PreToolUse.find((h: any) => h.matcher === "Bash|Edit|Write|MultiEdit|NotebookEdit").hooks[0].command).toBe("/opt/homebrew/bin/relay hook guard --task task-1 --gen 4 --url http://127.0.0.1:8790 --home /home/relay");
  expect(s.hooks.SessionStart[0].hooks[0].command).toBe("/opt/homebrew/bin/relay hook SessionStart --task task-1 --gen 4 --url http://127.0.0.1:8790 --home /home/relay");
  for (const event of ["SessionStart", "SubagentStart", "SubagentStop", "Stop", "SessionEnd"]) {
    const hook = s.hooks[event][0].hooks[0];
    expect(hook.type).toBe("command");
    expect(hook.command).toBe(`/opt/homebrew/bin/relay hook ${event} --task task-1 --gen 4 --url http://127.0.0.1:8790 --home /home/relay`);
    expect(hook.timeout).toBe(5); expect(hook.headers).toBeUndefined();
  }
  expect(s.hooks.PermissionRequest[0].hooks[0].type).toBe("http");
  expect(s.hooks.PermissionRequest[0].hooks[0].headers.Authorization).toBe("Bearer HT");
  expect(s.hooks.PermissionRequest[0].hooks[0].headers["X-Relay-Gen"]).toBe("4");
  expect(s.hooks.PermissionRequest[0].hooks[0].headers["X-Relay-Task"]).toBe("task-1");
  expect(JSON.parse(buildSettingsJson({ port: 1, allowPush: true, maxAgents: 1, bin: "relay" })).hooks.PreToolUse[1].hooks[0].command).toMatch(/ --allow-push$/);
  expect(s.hooks.PermissionRequest[0].hooks[0].timeout).toBe(900);   // held open until the user approves in the dashboard (Task 8)
  expect(s.permissions.deny).toContain("Bash(git push*)"); expect(s.permissions.deny).toContain("Edit(~/.claude/**)"); expect(s.permissions.deny.some((d: string) => d.startsWith("Write("))).toBe(false);   // Write(path) rules are never matched by file permission checks expect(s.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe("1"); expect(s.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe("10");
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
