// spikes/scripts/03-verdict.ts — ③ Stop verdict inputs: done / question / background task / blocked / AskUserQuestion disallowed / transcript lag.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { check, fixture, hookLines, parseBg, record, RESULTS, SANDBOX, settings, sh, stopAndRm, waitFor } from "./lib.ts";
const PORT = 8794, LOG = join(RESULTS, "03-verdict.jsonl");
rmSync(LOG, { force: true });
const hookd = Bun.spawn(["bun", join(import.meta.dir, "hookd.ts"), String(PORT), LOG], { stdout: "inherit", stderr: "inherit" }); await Bun.sleep(500);
const CASES: Record<string, string> = {
  done: "Create a file hello.txt containing 'hi', commit it, and finish with a RELAY: done block.",
  question: "You must choose between naming the new file a.txt or b.txt. Do not decide; end your turn with a RELAY: question block offering both options.",
  background: "Start `sleep 40` as a background Bash task (run_in_background), then end your turn with a RELAY: done block saying the sleep is running.",
  blocked: "Pretend you need a credential you do not have. End your turn with a RELAY: blocked block.",
  askuser: "Use the AskUserQuestion tool to ask me which color I prefer. If the tool is unavailable, say TOOL-UNAVAILABLE and finish with RELAY: done.",
};
const out: Record<string, unknown> = {};
for (const [name, prompt] of Object.entries(CASES)) {
  const before = hookLines(LOG).length;
  const bg = parseBg((await sh(["claude", "--bg", "-w", `relay-spike-v-${name}`, "-n", `relay-spike:verdict-${name}`, "--agent", "relay-worker", "--model", "claude-sonnet-5", "--effort", "low",
    "--permission-mode", "auto", "--settings", settings(PORT), prompt], { cwd: SANDBOX, timeoutMs: 60_000 })).stdout)!;
  const stop = await waitFor(async () => hookLines(LOG).slice(before).find((l) => l.e === "Stop"), 180_000);
  const tStop = stop.t;
  // transcript lag: how long until the transcript file's last assistant text equals last_assistant_message
  const tp = stop.body.transcript_path; let lag = -1;
  for (let i = 0; i < 40; i++) {
    const lines = readFileSync(tp, "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as any[];
    const lastText = [...lines].reverse().find((l) => l.type === "assistant")?.message?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") ?? "";
    if (lastText.trim() === String(stop.body.last_assistant_message).trim()) { lag = Date.now() - tStop; break; }
    await Bun.sleep(250);
  }
  const msg: string = stop.body.last_assistant_message ?? "";
  const marker = msg.match(/RELAY: (done|question|blocked)/)?.[1] ?? null;
  const pre = hookLines(LOG).slice(before).filter((l) => l.e === "PreToolUse").map((l) => l.body.tool_name);
  out[name] = { marker, background_tasks: stop.body.background_tasks, session_crons: stop.body.session_crons, stop_reason: stop.body.stop_reason ?? null, tools: pre, transcriptLagMs: lag };
  fixture(`stop-${name}`, stop.body);
  check(`verdict ${name} marker`, name === "askuser" ? !pre.includes("AskUserQuestion") : marker === (name === "background" ? "done" : name), JSON.stringify(out[name]));
  await stopAndRm(bg.short);
}
record({ verdict: out, agentFilesLoaded: Object.values(out).some((o: any) => o.marker !== null) });
hookd.kill();
