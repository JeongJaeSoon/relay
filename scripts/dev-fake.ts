// scripts/dev-fake.ts — UI development harness: real server, fake sessions.
import { mkdirSync } from "node:fs";
import { serve } from "../src/serve.ts";
import { FakeRunner } from "../src/runner/fake.ts";
import { hookTokenFor } from "../src/gateway/auth.ts";
process.env.RELAY_HOME = process.env.RELAY_HOME ?? `${process.env.HOME}/.config/relay-fake`; process.env.RELAY_NO_FILE_LOG = "1";
const fake = new FakeRunner(); let post: (body: any, task: string, gen: number) => Promise<void>;
const seq = async (short: string, task: string, prompt: string, gen: number) => {
  const row = fake.rows.get(short)!; const base = { session_id: row.session_id, transcript_path: "/dev/null", cwd: row.cwd };
  const send = (b: any) => post({ ...base, ...b }, task, gen); const wait = (ms: number) => Bun.sleep(ms);
  await wait(800); await send({ hook_event_name: "SessionStart", source: fake.calls.at(-1)?.kind === "resume" ? "resume" : "startup" }); await send({ hook_event_name: "UserPromptSubmit", prompt, prompt_id: crypto.randomUUID() });
  const tools = [["Read", { file_path: "/tmp/relay-fake/myapp/src/auth.ts" }], ["Edit", { file_path: "/tmp/relay-fake/myapp/src/auth.ts" }], ["Bash", { command: "bun test" }]] as const;
  if (/epic|에픽/.test(prompt)) for (const a of ["a1", "a2"]) { await send({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: `tu-${a}`, tool_input: { subagent_type: "relay-explore" } }); await send({ hook_event_name: "SubagentStart", agent_id: a, agent_type: "relay-explore" }); }
  for (const [tool_name, tool_input] of tools) { const tool_use_id = crypto.randomUUID(); await send({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id }); await wait(700); await send({ hook_event_name: "PostToolUse", tool_name, tool_input, tool_use_id, tool_response: "ok", duration_ms: 650 }); }
  if (/epic|에픽/.test(prompt)) for (const a of ["a1", "a2"]) { await wait(1500); await send({ hook_event_name: "SubagentStop", agent_id: a, agent_type: "relay-explore", last_assistant_message: "found 3 call sites" }); }
  if (/error|오류/.test(prompt)) { await send({ hook_event_name: "SessionEnd", reason: "other" }); fake.rows.get(short)!.alive = false; return; }
  const msg = /question|질문/.test(prompt) ? "Two options.\n\nRELAY: question\nWhat should the file be called?\n- a.txt\n- b.txt" : "Refactored auth into 3 modules.\n\nRELAY: done\nSplit auth into 3 modules. Changed: src/auth/*.ts. Verified: bun test passes.";
  await send({ hook_event_name: "Stop", last_assistant_message: msg, stop_hook_active: false, background_tasks: [], session_crons: [], prompt_id: crypto.randomUUID() });
};
const origSpawn = fake.spawn.bind(fake), origResume = fake.resume.bind(fake);
fake.spawn = async (spec) => { const r = await origSpawn(spec); void seq(r.short_id, spec.taskUuid, spec.prompt, Number(spec.env.RELAY_GEN ?? 1)); return r; };
fake.resume = async (p: any) => { const r = await origResume(p); void seq(r.short_id, p.env?.RELAY_TASK_UUID ?? "", p.prompt, Number(p.env?.RELAY_GEN ?? 1)); return r; };
const runClaude = async (args: string[]) => { const text = args.at(-1)!.split("[user message]\n")[1] ?? ""; const o = /follow.?up|후속|테스트도|그거/.test(text) ? { action: "route_to_task", task_id: "T-01", prompt: text, confidence: "high" } : /\bclose\b|닫아|종료/.test(text) ? { action: "close_task", task_id: "T-01", confidence: "high" } : !/myapp|refactor|리팩|\badd\b|추가|만들|\bfix\b|고쳐|epic|에픽|typo|오타|question|질문|error|오류/.test(text) ? { action: "answer_directly", answer: "(fake) " + text, confidence: "high" } : { action: "new_task", project: "myapp", title: text.slice(0, 20), size: /epic|에픽/.test(text) ? "epic" : /typo|오타/.test(text) ? "small" : "normal", prompt: text, confidence: "high" }; await Bun.sleep(900); return { code: 0, stdout: JSON.stringify({ structured_output: o, usage: { input_tokens: 25000, output_tokens: 40 } }), stderr: "" }; };
// Sessions relay never started: rows on the roster that no task owns. RELAY_FAKE_FOREIGN=2 puts two of them there, and
// the watchdog picks them up on its next poll (after the 30s grace that keeps our own nascent spawns out of the list).
const FOREIGN = Number(process.env.RELAY_FAKE_FOREIGN ?? 0);
for (let i = 1; i <= FOREIGN; i++)
  fake.rows.set(`ext${i}`, { short_id: `ext${i}`, session_id: `outside-session-${i}`, name: i === 1 ? "notes cleanup" : "", cwd: i === 1 ? "/Users/me/scratch/notes" : "/Users/me/code/other-repo", pid: 9000 + i, alive: true, busy: i === 1, waiting_for: null, raw: {} });
const { ctx } = await serve({ runner: fake, runClaude });
mkdirSync("/tmp/relay-fake/myapp/.git", { recursive: true });
post = async (body, task, gen) => { await fetch(`http://127.0.0.1:${ctx.cfg.port}/api/hooks`, { method: "POST", headers: { authorization: `Bearer ${hookTokenFor(ctx.tokens.hook, task)}`, "content-type": "application/json", "x-relay-task": task, "x-relay-gen": String(gen) }, body: JSON.stringify(body) }); };
if (!(ctx.db.query("select 1 from projects where name='myapp'").get())) await fetch(`http://127.0.0.1:${ctx.cfg.port}/api/projects`, { method: "POST", headers: { authorization: `Bearer ${ctx.tokens.api}`, "content-type": "application/json" }, body: JSON.stringify({ name: "myapp", path: "/tmp/relay-fake/myapp", description: "fake app", keywords: ["auth"] }) });
console.log(`dev-fake ready → http://127.0.0.1:${ctx.cfg.port}/  (try: "myapp: refactor auth", "a task with a question", "an epic task", "a task that errors", "follow-up: add tests too", "status?")`);
