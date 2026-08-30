// spikes/scripts/06-permhold.ts — hold the PermissionRequest hook response for N seconds and watch the worker.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { agents, check, fixture, hookLines, killHookds, parseBg, record, RESULTS, SANDBOX, settings, sh, spawnHookd, spikeAgents, stopAndRm, waitFor } from "./lib.ts";
const PORT = 8802, LOG = join(RESULTS, "06-permhold.jsonl");
rmSync(LOG, { force: true });
async function runCase(name: string, holdMs: number, hookTimeoutS: number) {
  const hookd = spawnHookd(PORT, LOG, ["--hold-perm", String(holdMs)], { PERM_DECISION: "allow" }); await Bun.sleep(500);
  const st = JSON.parse(settings(PORT)); st.hooks.PermissionRequest = [{ hooks: [{ type: "http", url: `http://127.0.0.1:${PORT}/hook`, timeout: hookTimeoutS }] }];
  const bg = parseBg((await sh(["claude", "--bg", "-n", `relay-spike:permhold-${name}`, "--model", "claude-sonnet-5", "--effort", "low", "--permission-mode", "manual", "--settings", JSON.stringify(st), "Create a file note.txt containing 'hi' using the Write tool, then reply DONE."], { cwd: SANDBOX, timeoutMs: 60_000 })).stdout)!;
  const row = await waitFor(async () => (await spikeAgents()).find((a) => a.name === `relay-spike:permhold-${name}`), 30_000);
  const req = await waitFor(async () => hookLines(LOG).find((l) => l.e === "PermissionRequest" && l.body.session_id === row.sessionId), 120_000);
  fixture("permission-request", req.body);
  const t0 = req.t; let statusDuringHold: any = null;
  await Bun.sleep(Math.min(holdMs, hookTimeoutS * 1000) / 2); statusDuringHold = (await agents()).find((a) => a.id === bg.short);
  // Measured: a PermissionRequest payload has NO tool_use_id (session_id, transcript_path, cwd, prompt_id,
  // permission_mode, effort, hook_event_name, tool_name, tool_input, permission_suggestions). Correlate on the
  // PreToolUse that precedes it instead — that one does carry tool_use_id.
  const tuid = [...hookLines(LOG)].reverse().find((l) => l.e === "PreToolUse" && l.t <= req.t && l.body.session_id === row.sessionId && l.body.tool_name === req.body.tool_name)?.body?.tool_use_id;
  const post = await waitFor(async () => hookLines(LOG).find((l) => l.e === "PostToolUse" && l.t >= req.t && l.body.tool_use_id === tuid), (holdMs + hookTimeoutS * 1000) + 60_000).catch(() => null);
  const stop = await waitFor(async () => hookLines(LOG).find((l) => l.e === "Stop" && l.body.session_id === row.sessionId), 60_000).catch(() => null);
  const after = (await agents(true)).find((a) => a.id === bg.short);
  const out = { holdMs, hookTimeoutS, toolUseId: tuid ?? null, workerWaitedMs: post ? post.t - t0 : null, statusDuringHold: statusDuringHold ? { state: statusDuringHold.state, status: statusDuringHold.status, waitingFor: statusDuringHold.waitingFor ?? null } : null, wroteFile: !!post, stopSeen: !!stop, finished: !!stop, afterState: after ? { state: after.state, status: after.status, waitingFor: after.waitingFor ?? null } : null };
  await stopAndRm(bg.short); hookd.kill(); return out;
}
const held = await runCase("held", 8_000, 60);       // relay answers after 8s: worker should block ~8s then write
const timedOut = await runCase("timeout", 40_000, 10); // hook times out (10s) before relay answers: what does the CLI do?
record({ permissionHold: { held, timedOut } });
check("worker waits for the held response and resumes", held.wroteFile && (held.workerWaitedMs ?? 0) >= 7_000, JSON.stringify(held));
check("hook timeout: the worker moves on by itself (PostToolUse or Stop within timeout+60s) — never hangs", !!(timedOut.wroteFile || timedOut.stopSeen), JSON.stringify(timedOut));
killHookds();
