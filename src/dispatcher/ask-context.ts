import type { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { now } from "../core/clock.ts";
import { rowToTask } from "../core/projections.ts";
import { log as slog } from "../log.ts";

// Bounds. A long-running task's JSONL is megabytes; feeding it whole would make a casual question the most expensive
// thing in the product. TAIL_BYTES is what we read off disk, BUDGET is what survives the digest into the prompt.
export const TRANSCRIPT_TAIL_BYTES = 32 * 1024;
export const TRANSCRIPT_BUDGET = 6_000;
const RECENT_EVENTS = 8;

/** The ONLY transcript an Ask may read: the `transcript_path` the CLI itself handed relay in a hook for THIS task,
 *  read back out of that task's own stored events.
 *  Never glob `~/.claude/projects/**` for a transcript — that would read sessions relay does not own, including the
 *  user's personal ones. A session relay was not given a path for (an externally started one, a subagent pseudo-task)
 *  simply has no transcript here, and the context says so.
 *  Never read `~/.claude/sessions/*.key` or any credential material; the one-shot inherits auth from the CLI the same
 *  way the dispatcher does. Transcripts are read-only, always (roadmap B8) — relay never writes one. */
export function transcriptPathFor(db: Database, taskUuid: string): string | null {
  const r = db.query(`select json_extract(payload_json,'$.transcript_path') p from events
    where task_uuid=? and type like 'hook.%' and json_extract(payload_json,'$.transcript_path') is not null order by seq desc limit 1`).get(taskUuid) as any;
  return r?.p ?? null;
}

const one = (s: string, n = 300) => s.replace(/\s+/g, " ").trim().slice(0, n);
/** One transcript record → one legible line. Keeps the shape `usage.sampleTranscript` already relies on. */
function summarise(j: any): string {
  const c = j?.message?.content;
  const parts = Array.isArray(c) ? c : typeof c === "string" ? [{ type: "text", text: c }] : [];
  const bits = parts.map((p: any) => (p.type === "text" ? one(p.text ?? "")
    : p.type === "tool_use" ? `→ ${p.name}${p.input?.command ? ` ${one(String(p.input.command), 120)}` : p.input?.file_path ? ` ${one(String(p.input.file_path), 120)}` : ""}`
    : p.type === "tool_result" ? `← ${one(typeof p.content === "string" ? p.content : JSON.stringify(p.content ?? ""), 200)}` : "")).filter(Boolean);
  return bits.length ? `${j.type ?? "?"}: ${bits.join(" | ")}` : "";
}

/** The tail of the transcript, digested to legible lines and capped. Reading only, never writing. */
export function transcriptDigest(path: string | null): string {
  if (!path || !existsSync(path)) return "";
  let text = "";
  try {
    const size = statSync(path).size; const from = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const fd = openSync(path, "r"); const buf = Buffer.alloc(size - from); readSync(fd, buf, 0, buf.length, from); closeSync(fd);
    text = buf.toString("utf8");
  } catch (e) { slog.warn("ask: transcript read failed", { path, e: String(e) }); return ""; }
  const lines = text.split("\n"); if (lines.length > 1 && text.length >= TRANSCRIPT_TAIL_BYTES) lines.shift();   // a tail usually starts mid-record
  const out: string[] = [];
  for (const line of lines) { if (!line.trim()) continue; try { const s = summarise(JSON.parse(line)); if (s) out.push(s); } catch { /* not a record we understand */ } }
  const kept: string[] = []; let budget = TRANSCRIPT_BUDGET;
  for (let i = out.length - 1; i >= 0; i--) { const cost = out[i].length + 1; if (cost > budget) break; kept.unshift(out[i]); budget -= cost; }
  return kept.join("\n");
}

/** Everything an Ask about one task may see: the state relay already holds, its recent events, and the transcript tail.
 *  Nothing here touches the worker — no send, no resume, no message into its inbox. */
export function buildAskContext(db: Database, taskUuid: string): string {
  const row = db.query("select * from tasks where uuid=?").get(taskUuid); if (!row) return "";
  const t = rowToTask(row);
  const project = (db.query("select name from projects where id=?").get(t.project_id) as any)?.name ?? t.project_id;
  const rel = (ms: number | null) => (ms == null ? "—" : `${Math.round((now() - ms) / 60_000)}m ago`);
  const events = db.query(`select type, payload_json from events where task_uuid=? and type like 'hook.%' order by seq desc limit ?`).all(taskUuid, RECENT_EVENTS) as any[];
  const digest = transcriptDigest(transcriptPathFor(db, taskUuid));
  return [
    `[task ${t.display_id}] "${t.title}" project=${project} status=${t.status} size=${t.size} model=${t.model}/${t.effort}`,
    `  process=${t.process_state}/${t.turn_state} started=${rel(t.started_at)} ended=${rel(t.ended_at)} tokens≈${t.usage_tokens}`,
    `  last step: ${t.last_step ?? "(none)"}`,
    `  last summary: ${t.last_summary ?? "(none)"}`,
    ...(t.question ? [`  waiting on: ${t.question.text}`] : []),
    "[recent events]",
    ...(events.length ? events.reverse().map((e) => { const p = JSON.parse(e.payload_json); return `- ${e.type.slice(5)}${p.tool_name ? " · " + p.tool_name : ""}`; }) : ["- (none)"]),
    "[transcript tail]",
    digest || "(relay was given no transcript for this task — nothing to read)",
  ].join("\n");
}
