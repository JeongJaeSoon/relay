// spikes/scripts/dispatch.ts — dispatcher prototype: one `claude -p` per message, structured output via --json-schema.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RESULTS, sh } from "./lib.ts";

export const DISPATCH_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["new_task", "route_to_task", "answer_directly", "close_task"] },
    task_id: { type: "string" }, project: { type: "string" }, title: { type: "string" },
    size: { type: "string", enum: ["small", "normal", "epic"] },
    prompt: { type: "string" }, answer: { type: "string" },
    confidence: { type: "string", enum: ["high", "low"] },
  },
  required: ["action", "confidence"],
};

export const DISPATCH_SYSTEM_PROMPT = `You are relay's dispatcher. You ONLY decide where a user message goes; you never do the work.
Actions: new_task (start a worker in a project), route_to_task (append to an existing task's session), answer_directly (short factual answer that needs no work), close_task (user asks to finish a task — will be confirmed by the user).
Rules:
- Prefer route_to_task when the message continues or answers an active task (same topic, "그거", "아까", replies to a question).
- new_task requires project, a short Korean title (<= 24 chars) and size: small (typo/one-file), normal (feature/refactor), epic (multi-day, many files).
- prompt: keep the user's original text; only add the minimal missing referent (e.g. the task title) when the target is implicit.
- confidence: low whenever the target task or project is ambiguous. Never guess.
Answer only through the structured output.`;

export type Ctx = { projects: { name: string; path: string; description: string; keywords: string[] }[]; tasks: { id: string; title: string; project: string; status: string; last_summary: string; last_active: string }[]; recent: string[] };
export const buildContext = (c: Ctx) => [
  "[projects]", ...c.projects.map((p) => `- ${p.name} (${p.path}) — ${p.description}; keywords: ${p.keywords.join(", ")}`),
  "[active tasks]", ...(c.tasks.length ? c.tasks.map((t) => `- ${t.id} "${t.title}" project=${t.project} status=${t.status} last_active=${t.last_active}\n  summary: ${t.last_summary}`) : ["- (none)"]),
  "[recent chat]", ...c.recent.map((r) => `- ${r}`),
].join("\n");

export async function decide(text: string, ctx: Ctx, model = "claude-fable-5", effort = "low", timeoutMs = 60_000) {
  const cwd = join(RESULTS, "dispatcher-cwd"); mkdirSync(cwd, { recursive: true });
  const t0 = Date.now();
  const r = await sh(["claude", "-p", "--output-format", "json", "--json-schema", JSON.stringify(DISPATCH_JSON_SCHEMA), "--max-turns", "1", "--tools", "", "--no-session-persistence",
    "--model", model, "--effort", effort, "--append-system-prompt", DISPATCH_SYSTEM_PROMPT, `${buildContext(ctx)}\n\n[user message]\n${text}`], { cwd, timeoutMs });
  let j: any = null; try { j = JSON.parse(r.stdout); } catch {}
  return { decision: j?.structured_output ?? null, meta: { wall_ms: Date.now() - t0, code: r.code, duration_ms: j?.duration_ms, usage: j?.usage, cost: j?.total_cost_usd, is_error: j?.is_error, stderr: r.stderr.slice(0, 200) } };
}
