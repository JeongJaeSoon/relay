import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DispatchDecision, Message } from "@shared/types.ts";
import { isAsk, stripAsk } from "@shared/ask.ts";
import { paths, type Config } from "../config.ts";
import { now } from "../core/clock.ts";
import { EventLog, loadMessage } from "../core/events.ts";
import { ulid } from "../core/ids.ts";
import { isStatusQuery, statusAnswer } from "../core/fastpath.ts";
import { log as slog } from "../log.ts";
import { buildAskContext } from "./ask-context.ts";
import { buildContext } from "./context.ts";
import { AnswerSchema, ANSWER_JSON_SCHEMA, DecisionSchema, dispatchJsonSchema, lowConfidence } from "./schema.ts";
import { ASK_SYSTEM_PROMPT, dispatchSystemPrompt } from "./system-prompt.ts";

const ASK_JSON_SCHEMA = JSON.stringify(ANSWER_JSON_SCHEMA);   // fixed: Ask mode's schema never depends on config
export type RunClaude = (args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
/** Absolute `claude` path from config (04 Global Constraints): launchd's minimal PATH has no brew/npm bin dir. */
export const bunRunClaude = (claudeBin = "claude"): RunClaude => async (args, { cwd, timeoutMs }) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "ANTHROPIC_API_KEY")) as Record<string, string>;
  const p = Bun.spawn([claudeBin, ...args], { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const t1 = setTimeout(() => p.kill("SIGINT"), timeoutMs); const t2 = setTimeout(() => p.kill("SIGTERM"), timeoutMs + 5000);
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited; clearTimeout(t1); clearTimeout(t2); return { code, stdout, stderr };
};
interface Opts { runClaude?: RunClaude; onDecision: (msg: Message, d: DispatchDecision, dispatchPatch: Partial<Message>) => void; onNeedsConfirm: (msg: Message, d: DispatchDecision | null, reason: string) => void; isPaused: () => boolean }

/** One `claude -p` per message, strictly serialized (global chain). */
export class Dispatcher {
  private chain: Promise<void> = Promise.resolve();
  private stamps: number[] = [];   // token bucket for rate limiting
  private run: RunClaude;
  private jsonSchema: string; private systemPrompt: string;   // both depend on dispatcher.max_split, which cannot change without a restart
  constructor(private db: Database, private log: EventLog, private cfg: Config, private opts: Opts) {
    this.run = opts.runClaude ?? bunRunClaude(cfg.claude_bin);
    this.jsonSchema = JSON.stringify(dispatchJsonSchema(cfg.dispatcher.max_split)); this.systemPrompt = dispatchSystemPrompt(cfg.dispatcher.max_split);
  }
  enqueue(messageId: string) { this.chain = this.chain.then(() => this.process(messageId)).catch((e) => slog.error("dispatcher chain error", { e: String(e) })); }
  /** Re-enqueue every pending message (startup, resume-all). */
  drainPending() { for (const r of this.db.query("select id from messages where role='user' and dispatch_state in ('pending','deciding') order by created_at").all() as any[]) this.enqueue(r.id); }
  private patch(id: string, patch: Partial<Message>, type = "dispatch.completed") { this.log.emit({ type, payload: { message_id: id, patch } }); }
  /** The dispatcher badge row (crosswalk §4): `dispatcher · action · size · project`, or the failure reason. */
  private badge(text: string) { this.log.emit({ type: "message.received", payload: { id: ulid(), role: "system", source: "user", client_message_id: null, dispatch_state: "direct", text, task_uuid: null, reply_to_task_uuid: null, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: now() } }); }
  private async process(id: string) {
    const msg = loadMessage(this.db, id); if (!msg || msg.dispatch_state !== "pending") return;
    if (this.opts.isPaused()) return;                                    // stays pending; resume-all calls drainPending()
    await this.rateLimit();
    // Ask mode was declared at submission and marked on the text by the gateway; the marker is the dispatcher's only
    // input from it, so it survives a restart (drainPending) and a replay. The fast path is tried first: declaring a
    // status question must never make it more expensive than the same words without the marker.
    const ask = isAsk(msg.text); const text = ask ? stripAsk(msg.text) : msg.text;
    // A message scoped to one task is not a system status query, however it is worded — the fast path's answer is the
    // whole system's. Same rule the reply path already has, same argument.
    if (isStatusQuery(text, msg.reply_to_task_uuid ?? msg.task_uuid)) {
      this.patch(id, { dispatch_state: "fastpath" }, "dispatch.fastpath");
      this.log.emit({ type: "message.received", payload: { id: ulid(), role: "dispatcher_answer", source: "user", client_message_id: null, dispatch_state: "direct", text: statusAnswer(this.db, this.cfg), task_uuid: null, reply_to_task_uuid: null, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: now() } });
      return;
    }
    this.patch(id, { dispatch_state: "deciding" }, "dispatch.started");
    const prev = this.db.query("select id from messages where role='user' and dispatch_state in ('dispatched','failed','needs_confirm','fastpath') and id<>? order by created_at desc limit 1").get(id) as any;
    if (ask) return this.answerQuestion(id, text, msg.task_uuid, prev?.id ?? null);
    const ctx = buildContext(this.db);
    let last: { decision: DispatchDecision | null; error: string } = { decision: null, error: "" };
    for (const effort of [this.cfg.dispatcher.effort, this.cfg.dispatcher.retry_effort]) {
      last = await this.decide(msg.text, ctx, effort, last.error);
      if (last.decision && !lowConfidence(last.decision)) break;
      if (last.error === "timeout") break;
    }
    if (last.error === "timeout" || (!last.decision && last.error)) { this.patch(id, { dispatch_state: "failed", dispatch_error: last.error, chain_prev_id: prev?.id ?? null }, "dispatch.failed"); this.badge(`dispatcher · failed · ${last.error}`); return; }
    if (!last.decision || lowConfidence(last.decision)) {                 // one low item sends the whole split to needs_confirm (C.4.2)
      this.patch(id, { dispatch_state: "needs_confirm", dispatch_json: last.decision, chain_prev_id: prev?.id ?? null }, "dispatch.completed");
      this.opts.onNeedsConfirm(loadMessage(this.db, id)!, last.decision, last.decision ? "confidence=low" : last.error); return;
    }
    // A9: the message's `dispatched` mark, the badge row, the task and its spawn command are committed together by TaskService.applyDecision (one transaction) — never here
    this.opts.onDecision(loadMessage(this.db, id)!, last.decision, { chain_prev_id: prev?.id ?? null });
  }
  /** Ask mode: the only reachable outcome is an answer. Same retry shape as routing, and one context — empty for a
   *  plain question, the target task's state and transcript tail for a task-scoped one. The worker is never touched:
   *  this spawns its own one-shot `claude -p`, exactly as the dispatcher does, and sends nothing to the session. */
  private async answerQuestion(id: string, question: string, taskUuid: string | null, prevId: string | null) {
    // Two contexts, one path: the target task's state and transcript tail, or — for a plain question — the same
    // projects/tasks/chat summary routing gets, minus the routing apparatus. A declared question needs less context
    // than routing, not none: without it the model cannot answer "why did T-02 fail" at all.
    const ctx = taskUuid ? buildAskContext(this.db, taskUuid) : buildContext(this.db, "ask");
    let last: { answer: string | null; error: string } = { answer: null, error: "" };
    for (const effort of [this.cfg.dispatcher.effort, this.cfg.dispatcher.retry_effort]) {
      last = await this.answer(question, ctx, effort, last.error);
      if (last.answer || last.error === "timeout") break;
    }
    if (!last.answer) { this.patch(id, { dispatch_state: "failed", dispatch_error: last.error, chain_prev_id: prevId }, "dispatch.failed"); this.badge(`dispatcher · failed · ${last.error}`); return; }
    // The decision is built here, from the answer alone. The model never names an action in Ask mode, so a question
    // cannot become new_task, route_to_task or close_task however it replies.
    this.opts.onDecision(loadMessage(this.db, id)!, { action: "answer_directly", answer: last.answer, confidence: "high" }, { chain_prev_id: prevId });
  }
  private async decide(text: string, ctx: string, effort: string, prevError: string) {
    const prompt = `${ctx}\n${prevError ? `\n[previous attempt failed: ${prevError} — answer strictly via the structured output]\n` : ""}\n[user message]\n${text}`;
    const { out, error } = await this.call(prompt, this.systemPrompt, this.jsonSchema, effort);
    if (error) return { decision: null, error };
    const parsed = DecisionSchema.safeParse(out);
    return parsed.success ? { decision: parsed.data, error: "" } : { decision: null, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  private async answer(question: string, ctx: string, effort: string, prevError: string) {
    const prompt = `${ctx ? `${ctx}\n\n` : ""}${prevError ? `[previous attempt failed: ${prevError} — answer strictly via the structured output]\n\n` : ""}[user message]\n${question}`;
    const { out, error } = await this.call(prompt, ASK_SYSTEM_PROMPT, ASK_JSON_SCHEMA, effort);
    if (error) return { answer: null, error };
    const parsed = AnswerSchema.safeParse(out);
    return parsed.success ? { answer: parsed.data.answer, error: "" } : { answer: null, error: "no answer in the structured output" };
  }
  private async call(prompt: string, system: string, jsonSchema: string, effort: string): Promise<{ out: unknown; error: string }> {
    const cwd = join(paths.home, "dispatcher-cwd"); mkdirSync(cwd, { recursive: true });
    const args = ["-p", "--output-format", "json", "--json-schema", jsonSchema, "--max-turns", "1", "--tools", "", "--no-session-persistence",
      "--model", this.cfg.dispatcher.model, "--effort", effort, "--append-system-prompt", system, prompt];
    const t0 = now();
    const r = await this.run(args, { cwd, timeoutMs: this.cfg.dispatcher.timeout_ms });
    if (now() - t0 >= this.cfg.dispatcher.timeout_ms || r.code === 130 || r.code === 143) return { out: null, error: "timeout" };   // SIGINT → 130, SIGTERM → 143
    let j: any; try { j = JSON.parse(r.stdout); } catch { return { out: null, error: `unparseable stdout: ${r.stdout.slice(0, 120)}` }; }
    if (j.usage) this.log.emit({ type: "usage.sampled", payload: { source: "dispatcher", delta: (j.usage.input_tokens ?? 0) + (j.usage.output_tokens ?? 0) + (j.usage.cache_creation_input_tokens ?? 0) + (j.usage.cache_read_input_tokens ?? 0), cost: j.total_cost_usd ?? null } });
    return { out: j.structured_output, error: "" };
  }
  private async rateLimit() {
    const win = 60_000, n = this.cfg.dispatcher.rate_per_min;
    for (;;) { const t = now(); this.stamps = this.stamps.filter((s) => t - s < win); if (this.stamps.length < n) { this.stamps.push(t); return; } await Bun.sleep(this.stamps[0] + win - t + 5); }
  }
}
