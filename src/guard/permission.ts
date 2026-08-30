// src/guard/permission.ts — deterministic PermissionRequest policy (v1): allow / deny / ask (→ dashboard approval).
import type { Task } from "@shared/types.ts";
import { guardDecision } from "./pretooluse.ts";
const SAFE_BASH = /^(npm|bun|pnpm|yarn)\s+(test|run\s+test|run\s+lint|run\s+build|lint|build)\b|^(pytest|go\s+test|cargo\s+test|cargo\s+build|make\s+test|tsc\b|eslint\b|prettier\b|git\s+(status|diff|log|show|branch|add|commit|stash)\b|ls\b|cat\b|grep\b|rg\b|find\b|head\b|tail\b|wc\b)/;
export class PermissionPolicy {
  constructor(private allowPush: boolean) {}
  decide(body: any, task: Task): "allow" | "deny" | "ask" {
    const g = guardDecision(body, { cwd: task.worktree_path ?? String(body.cwd ?? ""), RELAY_ALLOW_PUSH: this.allowPush ? "1" : "0" });
    if (g.block) return "deny";
    const tool = String(body.tool_name ?? "");
    if (["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "ListAgents"].includes(tool)) return "allow";
    if (tool === "Bash" && SAFE_BASH.test(String(body.tool_input?.command ?? "").trim())) return "allow";
    if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) return "allow";     // inside the worktree (guard already checked)
    return "ask";
  }
}
