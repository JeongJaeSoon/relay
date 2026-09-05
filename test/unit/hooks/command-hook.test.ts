import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("lifecycle command hooks preserve replayable records when the gateway is offline", async () => {
  const home = mkdtempSync(join(tmpdir(), "relay-command-hook-"));
  try {
    for (const event of ["SessionStart", "SubagentStart", "SubagentStop", "Stop", "SessionEnd"]) {
      const child = Bun.spawn([process.execPath, "-e", `import { runCommandHook } from ${JSON.stringify(new URL("../../../src/hooks/command-hook.ts", import.meta.url).pathname)}; await runCommandHook(${JSON.stringify(event)}, ["--task", "qa-task", "--gen", "7", "--url", "http://127.0.0.1:1", "--home", ${JSON.stringify(home)}]);`], {
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      child.stdin.write(JSON.stringify({ hook_event_name: event, session_id: "qa-session", agent_id: "qa-child", prompt_id: "qa-turn", last_assistant_message: "RELAY: done\nVerified output", reason: "other" }));
      child.stdin.end();
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toBe("");
      expect(await new Response(child.stderr).text()).toBe("");
    }
    const files = readdirSync(join(home, "hook-spool")).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(5);
    const records = files.map((f) => {
      expect(statSync(join(home, "hook-spool", f)).mode & 0o777).toBe(0o600);
      return JSON.parse(readFileSync(join(home, "hook-spool", f), "utf8"));
    });
    expect(records.map((r) => r.body.hook_event_name).sort()).toEqual(["SessionStart", "SubagentStart", "SubagentStop", "Stop", "SessionEnd"].sort());
    for (const r of records) {
      expect(r.headers).toEqual({ "x-relay-task": "qa-task", "x-relay-gen": "7" });
      expect(r.body.relay_gen).toBe("7");
      expect(r.body.last_assistant_message).toBe("RELAY: done\nVerified output");
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
