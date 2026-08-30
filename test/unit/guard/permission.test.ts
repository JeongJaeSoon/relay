import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionPolicy } from "../../../src/guard/permission.ts";
const wt = mkdtempSync(join(tmpdir(), "relay-perm-")); mkdirSync(join(wt, "src"), { recursive: true });
const task: any = { worktree_path: wt };
const d = (tool_name: string, tool_input: unknown, allowPush = false) => new PermissionPolicy(allowPush).decide({ tool_name, tool_input, cwd: wt }, task);
test("policy: safe commands allow, guard violations deny, the rest ask", () => {
  expect(d("Bash", { command: "bun test" })).toBe("allow"); expect(d("Bash", { command: "git status" })).toBe("allow"); expect(d("Read", { file_path: "/etc/hosts" })).toBe("allow");
  expect(d("Bash", { command: "git push origin main" })).toBe("deny"); expect(d("Bash", { command: "git push origin main" }, true)).toBe("ask");
  expect(d("Write", { file_path: "/etc/hosts" })).toBe("deny"); expect(d("Write", { file_path: join(wt, "src/a.ts") })).toBe("allow");
  expect(d("Bash", { command: "rm -rf build" })).toBe("ask"); expect(d("WebFetch", { url: "https://x" })).toBe("allow"); expect(d("Bash", { command: "npm publish" })).toBe("ask");
});
