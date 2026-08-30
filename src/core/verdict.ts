import type { Task, TaskQuestion } from "@shared/types.ts";
import { now } from "./clock.ts";

export interface Verdict { status: "done" | "waiting_input" | "needs_review" | "running"; summary: string | null; question: TaskQuestion | null; reason: string }
const MARKER = /(?:^|\n)RELAY: (done|question|blocked)[ \t]*\n?([\s\S]*)$/;

export function parseMarker(text: string) {
  const m = text.match(MARKER); if (!m) return null;
  const lines = m[2].trim().split("\n").map((l) => l.trim());
  const options = lines.filter((l) => /^[-*•] /.test(l)).map((l) => l.replace(/^[-*•] /, "").trim());
  const body = lines.filter((l) => !/^[-*•] /.test(l)).join(" ").trim();
  return { kind: m[1] as "done" | "question" | "blocked", body, options };
}
const firstParagraph = (s: string) => s.trim().split(/\n\s*\n|\n/)[0]?.trim().slice(0, 300) ?? "";

/** Roadmap B4 Stop row: what the end of a turn means for the task. */
export function verdict(body: { last_assistant_message?: string; background_tasks?: unknown[]; session_crons?: unknown[] }, task: Task): Verdict {
  if ((body.background_tasks?.length ?? 0) > 0 || (body.session_crons?.length ?? 0) > 0) return { status: "running", summary: null, question: null, reason: "background work continues" };
  const msg = String(body.last_assistant_message ?? "").trim();
  if (!msg) return task.status === "waiting_input" && task.question ? { status: "waiting_input", summary: null, question: task.question, reason: "question still pending" } : { status: "needs_review", summary: null, question: null, reason: "empty last_assistant_message" };
  const mk = parseMarker(msg);
  if (mk?.kind === "done") return { status: "done", summary: mk.body || firstParagraph(msg.replace(MARKER, "")), question: null, reason: "marker done" };
  if (mk?.kind === "question") return { status: "waiting_input", summary: null, question: { text: mk.body, options: mk.options, asked_at: now(), source: "marker" }, reason: "marker question" };
  if (mk?.kind === "blocked") return { status: "waiting_input", summary: null, question: { text: `Blocked: ${mk.body}`, options: mk.options, asked_at: now(), source: "marker" }, reason: "marker blocked" };
  if (task.status === "waiting_input" && task.question?.source === "permission") return { status: "waiting_input", summary: null, question: task.question, reason: "permission pending" };
  return { status: "needs_review", summary: firstParagraph(msg), question: null, reason: "marker missing" };
}
