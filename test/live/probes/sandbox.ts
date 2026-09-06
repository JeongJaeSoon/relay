// test/live/probes/sandbox.ts — (re)create the sandbox git repo used by spike workers.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { SANDBOX, sh } from "./lib.ts";
if (existsSync(SANDBOX)) throw new Error("Probe sandbox already exists. Inspect sessions and retained work before manually removing it.");
mkdirSync(SANDBOX, { recursive: true });
writeFileSync(`${SANDBOX}/README.md`, "# relay spike sandbox\n\nhello\n");
writeFileSync(`${SANDBOX}/.gitignore`, ".claude/worktrees/\n");
for (const c of [["git", "init", "-b", "main"], ["git", "add", "-A"], ["git", "-c", "user.email=spike@relay", "-c", "user.name=spike", "commit", "-qm", "init"]])
  await sh(c, { cwd: SANDBOX });
console.log("sandbox ready:", SANDBOX);
