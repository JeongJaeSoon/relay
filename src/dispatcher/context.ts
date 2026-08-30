import type { Database } from "bun:sqlite";
import { loadProjects, rowToMessage, rowToTask } from "../core/projections.ts";
import { now } from "../core/clock.ts";

const ago = (t: number) => { const m = Math.round((now() - t) / 60_000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };

/** Projects, active tasks and the last five chat lines — everything the judge sees besides the message itself. */
export function buildContext(db: Database): string {
  const projects = loadProjects(db);
  const tasks = db.query("select * from tasks where parent_uuid is null and status not in ('closed') order by updated_at desc limit 20").all().map(rowToTask);
  const recent = db.query("select * from (select * from messages where role in ('user','worker_summary','question','dispatcher_answer','system') order by created_at desc limit 5) order by created_at").all().map(rowToMessage);
  return [
    "[projects]", ...(projects.length ? projects.map((p) => `- ${p.name} (${p.path}) — ${p.description}; keywords: ${p.keywords.join(", ")}`) : ["- (none registered)"]),
    "[active tasks]", ...(tasks.length ? tasks.map((t) => `- ${t.display_id} "${t.title}" project=${projects.find((p) => p.id === t.project_id)?.name ?? t.project_id} status=${t.status} last_active=${ago(t.updated_at)}\n  summary: ${t.last_summary ?? "(none yet)"}${t.question ? `\n  waiting on question: ${t.question.text}` : ""}`) : ["- (none)"]),
    "[recent chat]", ...recent.map((m) => `- ${m.role}: ${m.text.slice(0, 200)}${m.dispatch_json ? ` → ${m.dispatch_json.action}${m.dispatch_json.task_id ? " " + m.dispatch_json.task_id : ""}` : ""}`),
  ].join("\n");
}
