// Real-CLI smoke: one actual `claude --bg` worker session end to end (RELAY_E2E=1 only).
// The dispatcher is scripted so the run costs one worker session and nothing else; everything after that — spawn,
// worktree, hooks, verdict, close — is the real CLI. The session is always stopped and removed, including on failure.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/serve.ts";
const run = process.env.RELAY_E2E === "1" ? test : test.skip;
const sh = (cmd: string[], cwd: string) => { const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" }); return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }; };
const claudeBin = process.env.RELAY_CLAUDE_BIN ?? "claude";
const TITLE = "relay-smoke";                                   // the spawned session is named `relay:T-01 relay-smoke`
describe("e2e with real claude", () => {
  run("small task completes through real hooks", async () => {
    const home = mkdtempSync(join(tmpdir(), "relay-e2e-home-")); const proj = mkdtempSync(join(tmpdir(), "relay-e2e-proj-"));
    process.env.RELAY_HOME = home; process.env.RELAY_LOG_DIR = home; delete process.env.RELAY_NO_FILE_LOG;
    process.env.RELAY_BIN = join(import.meta.dir, "..", "..", "scripts", "relay-dev"); chmodSync(process.env.RELAY_BIN, 0o755);
    writeFileSync(join(home, "config.toml"), `port = 8799\nclaude_bin = "${Bun.which(claudeBin) ?? claudeBin}"\n[worker]\nmodel = "claude-sonnet-5"\n[usage]\nmax_tool_calls_per_turn = 60\n`);
    writeFileSync(join(proj, "README.md"), "# smoke\n");
    for (const c of [["git", "init", "-q"], ["git", "add", "-A"], ["git", "-c", "user.email=e2e@relay", "-c", "user.name=relay", "commit", "-qm", "init"]]) sh(c, proj);
    const decision = { action: "new_task", project: "smoke", title: TITLE, size: "small", prompt: "README.md 끝에 'relay was here' 한 줄을 추가하고 커밋하라. 끝나면 RELAY: done 블록으로 보고하라.", confidence: "high" };
    const { ctx, stop } = await serve({ runClaude: async () => ({ code: 0, stdout: JSON.stringify({ structured_output: decision, usage: {} }), stderr: "" }) });
    const api = (p: string, b?: unknown, m = "POST") => fetch(`http://127.0.0.1:${ctx.cfg.port}/api${p}`, { method: m, headers: { authorization: `Bearer ${ctx.tokens.api}`, "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
    let task: any;
    try {
      expect((await api("/projects", { name: "smoke", path: proj, description: "relay smoke", keywords: ["smoke"] })).status).toBe(201);
      expect((await api("/messages", { text: "README에 한 줄 추가해줘", client_message_id: "e2e-1" })).status).toBe(202);
      const t0 = Date.now();
      while (Date.now() - t0 < 8 * 60_000) {
        const s = (await (await api("/tasks", undefined, "GET")).json()) as any; task = s.tasks[0];
        if (task && ["done", "needs_review", "error", "waiting_input", "cancelled"].includes(task.status)) break;
        await Bun.sleep(3000);
      }
      console.log("e2e task:", JSON.stringify({ status: task?.status, short_id: task?.short_id, session_id: task?.session_id, worktree: task?.worktree_path, last_step: task?.last_step, summary: task?.last_summary, usage: task?.usage_tokens }));
      expect(task.status).toBe("done"); expect(task.last_summary).toMatch(/\S/);
      expect(task.worktree_path).toMatch(/\S/); expect(readFileSync(join(task.worktree_path, "README.md"), "utf8")).toMatch(/relay was here/);
      expect((await api(`/tasks/${task.uuid}/close`)).status).toBe(200); await Bun.sleep(5000);
    } finally {
      // never touch a session that is not ours: only our recorded short id, and only rows named for this smoke run in our temp project
      const ours = new Set<string>([task?.short_id].filter(Boolean));
      const list = sh([claudeBin, "agents", "--json", "--all"], proj);
      if (list.code === 0) { try { for (const r of JSON.parse(list.out) as any[]) if (String(r.name ?? "").includes(TITLE) && realpathSync(String(r.cwd ?? "/")).startsWith(realpathSync(proj)) && r.id) ours.add(r.id); } catch {} }
      for (const id of ours) {
        sh([claudeBin, "stop", id], proj); let rm = sh([claudeBin, "rm", id], proj);
        if (rm.code !== 0) {   // `claude rm` keeps a worktree holding unpushed commits (measured) — this is a throwaway temp repo, so drop it and retry
          const real = realpathSync(proj);                                    // macOS puts the temp dir under /var, a symlink to /private/var — compare resolved paths or nothing matches
          for (const wt of sh(["git", "worktree", "list", "--porcelain"], proj).out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9)))
            if (realpathSync(wt).startsWith(real) && realpathSync(wt) !== real) { sh(["git", "worktree", "unlock", wt], proj); sh(["git", "worktree", "remove", "-f", "-f", wt], proj); }
          rm = sh([claudeBin, "rm", id], proj);
        }
        console.log("cleanup", id, rm.code, (rm.out + rm.err).trim().slice(0, 200));
        expect(sh([claudeBin, "agents", "--json", "--all"], proj).out).not.toContain(id);   // never leave a session behind
      }
      stop();
      if (existsSync(join(home, "relay.log"))) console.log("log tail:", readFileSync(join(home, "relay.log"), "utf8").split("\n").slice(-8).join("\n"));
    }
  }, 10 * 60_000);
});
