import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DispatchDecision, Message } from "@shared/types.ts";
import { paths, type Config } from "../config.ts";
import { now } from "../core/clock.ts";
import { EventLog, loadMessage } from "../core/events.ts";
import { ulid } from "../core/ids.ts";
import { isStatusQuery, statusAnswer } from "../core/fastpath.ts";
import { log as slog } from "../log.ts";
import { buildContext } from "./context.ts";
import { DecisionSchema, dispatchJsonSchema, lowConfidence } from "./schema.ts";
import { dispatchSystemPrompt } from "./system-prompt.ts";

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
    if (isStatusQuery(msg.text, msg.reply_to_task_uuid)) {
      this.patch(id, { dispatch_state: "fastpath" }, "dispatch.fastpath");
      this.log.emit({ type: "message.received", payload: { id: ulid(), role: "dispatcher_answer", source: "user", client_message_id: null, dispatch_state: "direct", text: statusAnswer(this.db, this.cfg), task_uuid: null, reply_to_task_uuid: null, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: now() } });
      return;
    }
    this.patch(id, { dispatch_state: "deciding" }, "dispatch.started");
    const prev = this.db.query("select id from messages where role='user' and dispatch_state in ('dispatched','failed','needs_confirm','fastpath') and id<>? order by created_at desc limit 1").get(id) as any;
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
  private async decide(text: string, ctx: string, effort: string, prevError: string) {
    const cwd = join(paths.home, "dispatcher-cwd"); mkdirSync(cwd, { recursive: true });
    const prompt = `${ctx}\n${prevError ? `\n[previous attempt failed: ${prevError} — answer strictly via the structured output]\n` : ""}\n[user message]\n${text}`;
    const args = ["-p", "--output-format", "json", "--json-schema", this.jsonSchema, "--max-turns", "1", "--tools", "", "--no-session-persistence",
      "--model", this.cfg.dispatcher.model, "--effort", effort, "--append-system-prompt", this.systemPrompt, prompt];
    const t0 = now();
    const r = await this.run(args, { cwd, timeoutMs: this.cfg.dispatcher.timeout_ms });
    if (now() - t0 >= this.cfg.dispatcher.timeout_ms || r.code === 130 || r.code === 143) return { decision: null, error: "timeout" };   // SIGINT → 130, SIGTERM → 143
    let j: any; try { j = JSON.parse(r.stdout); } catch { return { decision: null, error: `unparseable stdout: ${r.stdout.slice(0, 120)}` }; }
    if (j.usage) this.log.emit({ type: "usage.sampled", payload: { source: "dispatcher", delta: (j.usage.input_tokens ?? 0) + (j.usage.output_tokens ?? 0) + (j.usage.cache_creation_input_tokens ?? 0) + (j.usage.cache_read_input_tokens ?? 0), cost: j.total_cost_usd ?? null } });
    const parsed = DecisionSchema.safeParse(j.structured_output);
    return parsed.success ? { decision: parsed.data, error: "" } : { decision: null, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  private async rateLimit() {
    const win = 60_000, n = this.cfg.dispatcher.rate_per_min;
    for (;;) { const t = now(); this.stamps = this.stamps.filter((s) => t - s < win); if (this.stamps.length < n) { this.stamps.push(t); return; } await Bun.sleep(this.stamps[0] + win - t + 5); }
  }
}
