// spikes/scripts/sandbox.ts — (re)create the sandbox git repo used by spike workers.
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { SANDBOX, sh } from "./lib.ts";
rmSync(SANDBOX, { recursive: true, force: true }); mkdirSync(SANDBOX, { recursive: true });
writeFileSync(`${SANDBOX}/README.md`, "# relay spike sandbox\n\nhello\n");
writeFileSync(`${SANDBOX}/.gitignore`, ".claude/worktrees/\n");
for (const c of [["git", "init", "-b", "main"], ["git", "add", "-A"], ["git", "-c", "user.email=spike@relay", "-c", "user.name=spike", "commit", "-qm", "init"]])
  await sh(c, { cwd: SANDBOX });
console.log("sandbox ready:", SANDBOX);
