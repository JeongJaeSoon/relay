// spikes/scripts/04-races.ts — ④ race matrix. Each case records what the CLI does when two lifecycle actions overlap.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { caps, check, hookLines, parseBg, record, RESULTS, SANDBOX, settings, sh, spikeAgents, stopAndRm, waitFor } from "./lib.ts";
const PORT = 8795, LOG = join(RESULTS, "04-races.jsonl");
rmSync(LOG, { force: true });
let hookd = Bun.spawn(["bun", join(import.meta.dir, "hookd.ts"), String(PORT), LOG], { stdout: "inherit", stderr: "inherit" }); await Bun.sleep(500);
const races: Record<string, string> = {};
const spawnWorker = async (name: string, prompt: string) => {
  const bg = parseBg((await sh(["claude", "--bg", "-w", `relay-spike-r-${name}`, "-n", `relay-spike:race-${name}`, "--agent", "relay-worker", "--model", "claude-sonnet-5", "--effort", "low", "--permission-mode", "auto", "--settings", settings(PORT), prompt], { cwd: SANDBOX, timeoutMs: 60_000 })).stdout)!;
  const row = await waitFor(async () => (await spikeAgents()).find((a) => a.name === `relay-spike:race-${name}`), 30_000);
  return { ...bg, row };
};
const resumeSend = async (w: { row: any }, text: string) => parseBg((await sh(["claude", "--bg", "--resume", w.row.sessionId, "-n", w.row.name, "--settings", settings(PORT), text], { cwd: w.row.cwd, timeoutMs: 60_000 })).stdout);

// A. Stop ↔ send: send at the exact moment the Stop hook arrives (resume path: stop is racing the session's own turn end)
{
  const w = await spawnWorker("stopsend", "Reply OK, then RELAY: done.");
  await waitFor(async () => hookLines(LOG).some((l) => l.e === "Stop" && l.body.session_id === w.row.sessionId), 120_000);
  const stopP = sh(["claude", "stop", w.short], { timeoutMs: 15_000 });
  const sendP = resumeSend(w, "[relay #race0001] reply RACE-A");
  const [, r] = await Promise.all([stopP, sendP]);
  const arrived = await waitFor(async () => hookLines(LOG).some((l) => l.e === "UserPromptSubmit" && String(l.body.prompt).includes("race0001")), 60_000).then(() => true).catch(() => false);
  races.stopVsSend = `${r ? "resume-spawned" : "resume-refused"}/${arrived ? "arrived" : "lost"}`; await stopAndRm(r?.short ?? w.short);
}
// B. idle stop ↔ reply: stop the process and immediately resume with an answer (what relay does when the 15-min idle stop races a user reply)
{
  const w = await spawnWorker("idlereply", "End your turn with RELAY: question asking whether to use a.txt or b.txt.");
  await waitFor(async () => hookLines(LOG).some((l) => l.e === "Stop" && l.body.session_id === w.row.sessionId), 120_000);
  await sh(["claude", "stop", w.short], { timeoutMs: 15_000 });
  const r = await resumeSend(w, "[relay #race0002] a.txt. Create it and finish with RELAY: done.");
  const done = await waitFor(async () => hookLines(LOG).some((l) => l.e === "Stop" && /RELAY: done/.test(l.body.last_assistant_message ?? "") && l.body.session_id === w.row.sessionId), 180_000).then(() => true).catch(() => false);
  races.idleStopVsReply = done ? "ok" : "no-done"; await stopAndRm(r?.short ?? w.short);
}
// C. interrupt ↔ SubagentStop: stop the parent while a subagent runs; does SubagentStop/SessionEnd still arrive?
{
  const w = await spawnWorker("subint", "Delegate to the relay-explore subagent: 'run `sleep 20` then list files'. Wait for it, then RELAY: done.");
  await waitFor(async () => hookLines(LOG).some((l) => l.e === "SubagentStart" && l.body.session_id === w.row.sessionId), 120_000);
  await sh(["claude", "stop", w.short], { timeoutMs: 15_000 });
  await Bun.sleep(5000);
  const ev = hookLines(LOG).filter((l) => l.body.session_id === w.row.sessionId).map((l) => l.e);
  races.interruptVsSubagentStop = `SubagentStop:${ev.includes("SubagentStop")} SessionEnd:${ev.includes("SessionEnd")}`; await stopAndRm(w.short);
}
// D. restart ↔ hook POST: kill hookd while a worker runs; hooks are lost (no spool here) — count how many, then restart and confirm later hooks arrive
{
  const w = await spawnWorker("hookgap", "Run `sleep 3` five times with Bash (separate calls), then RELAY: done.");
  await waitFor(async () => hookLines(LOG).some((l) => l.e === "PreToolUse" && l.body.session_id === w.row.sessionId), 120_000);
  hookd.kill(); await Bun.sleep(6000);
  hookd = Bun.spawn(["bun", join(import.meta.dir, "hookd.ts"), String(PORT), LOG], { stdout: "inherit", stderr: "inherit" }); await Bun.sleep(500);
  await waitFor(async () => hookLines(LOG).some((l) => l.e === "Stop" && l.body.session_id === w.row.sessionId), 180_000).catch(() => null);
  const posts = hookLines(LOG).filter((l) => l.body.session_id === w.row.sessionId && l.e === "PostToolUse").length;
  races.restartVsHookPost = `postToolUseSeen:${posts}/5 (gap ≈6s) — worker not blocked: ${hookLines(LOG).some((l) => l.e === "Stop" && l.body.session_id === w.row.sessionId)}`;
  await stopAndRm(w.short);
}
// E. kill -9 the worker process: does the supervisor restart it (C1)? what does relay see (SessionEnd? SessionStart source? new pid, roster attempt)?
{
  const w = await spawnWorker("kill9", "Run `sleep 120` with Bash, then RELAY: done.");
  await waitFor(async () => hookLines(LOG).some((l) => l.e === "PreToolUse" && l.body.session_id === w.row.sessionId), 120_000);
  const before = hookLines(LOG).length; const t0 = Date.now(); process.kill(w.row.pid, "SIGKILL");
  let restarted: any = null;
  for (let i = 0; i < 40 && !restarted; i++) { await Bun.sleep(1500); const r = (await spikeAgents(true)).find((a) => a.sessionId === w.row.sessionId); if (r?.pid && r.pid !== w.row.pid) restarted = r; }
  const ev = hookLines(LOG).slice(before).filter((l) => l.body.session_id === w.row.sessionId).map((l) => `${l.e}${l.e === "SessionStart" ? ":" + l.body.source : ""}`);
  const roster = existsSync(join(homedir(), ".claude", "daemon", "roster.json")) ? JSON.parse(readFileSync(join(homedir(), ".claude", "daemon", "roster.json"), "utf8")) : null;
  const attempt = roster?.workers?.[w.short]?.attempt ?? null;
  races.kill9 = `restarted:${!!restarted}${restarted ? ` after ${Date.now() - t0}ms newPid:${restarted.pid}` : ""} hooks:[${ev.join(",")}] rosterAttempt:${attempt}`;
  record({ daemon: { restartsKilledWorker: !!restarted, restartDelayMs: restarted ? Date.now() - t0 : null, hooksAfterKill: ev, rosterAttempt: attempt } });
  await stopAndRm(restarted?.id ?? w.short);
}
record({ races: { ...(caps().races ?? {}), ...races } });
check("races: every case produced a verdict string", Object.values(races).every((v) => typeof v === "string" && v.length > 0 && !/undefined|NaN/.test(v)), JSON.stringify(races));
check("hookd restart does not block the worker", /worker not blocked: true/.test(String(races.restartVsHookPost)), String(races.restartVsHookPost));
check("kill -9: the supervisor restarts the worker and relay sees a SessionStart", /restarted:true/.test(String(races.kill9)) && /SessionStart/.test(String(races.kill9)), String(races.kill9));   // C1 — if this fails, the watchdog (not the daemon) owns restarts
hookd.kill();
