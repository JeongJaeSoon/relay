// spikes/scripts/02-delivery-matrix.ts — deliver a message to a worker in each process state and record the outcome.
// states: busy (long Bash running), idle (after Stop), stopped (after claude stop) ; plus burst of 10 to an idle worker
//
// Adapted to what Task 2 Step 3 actually measured:
//  - the inbox socket cannot be derived from `agents --json` (background rows carry no pid); it comes from the session
//    registry ~/.claude/sessions/<pid>.json, matched on sessionId (lib.peerSocketFor).
//  - the receiver sends NO status frame back, so `accepted/held/refused` is not observable on the socket. The outcome
//    signal is the `[relay #…]` marker showing up in the worker's UserPromptSubmit hook (roadmap B3's fallback is the
//    only signal there is).
import { join } from "node:path";
import { caps, check, hookLines, killHookds, parseBg, peerFrame, peerSocketFor, record, RESULTS, SANDBOX, settings, sh, socketSend, spawnHookd, spikeAgents, stopAndRm, waitFor } from "./lib.ts";
import { rmSync } from "node:fs";
const PORT = 8793, LOG = join(RESULTS, "02-matrix.jsonl");
rmSync(LOG, { force: true });
spawnHookd(PORT, LOG); await Bun.sleep(500);
const delivery = caps().delivery ?? "resume";
const results: Record<string, string> = {};
const acks: unknown[] = [];
const bg = parseBg((await sh(["claude", "--bg", "-n", "relay-spike:matrix", "--model", "claude-sonnet-5", "--effort", "low", "--permission-mode", "auto", "--settings", settings(PORT),
  "Run `sleep 25` with Bash, then reply DONE-1."], { cwd: SANDBOX, timeoutMs: 60_000 })).stdout)!;
const row = await waitFor(async () => (await spikeAgents()).find((a) => a.name === "relay-spike:matrix"), 30_000);
const selfSock = `/tmp/cc-socks/relay-spike-matrix-${process.pid}.sock`;   // we never listen; this is only the frame's `from`
async function send(marker: string, text: string, holdMs = 45_000): Promise<string> {
  if (delivery === "socket") {
    const sock = await waitFor(async () => peerSocketFor(row.sessionId), 20_000).catch(() => null);
    if (!sock) return "no-socket";
    // hold the connection open: a busy receiver only drains its inbox at a turn boundary, and closing early loses the frame
    const r = await socketSend(sock, peerFrame(selfSock, "relay-spike", `[relay #${marker}] ${text}`), holdMs);
    acks.push({ marker, replies: r.replies, error: r.error });
    return r.error ? "error" : r.replies.length ? String((r.replies[0] as any).status ?? "reply") : "no-ack";
  }
  // resume issues a NEW short id each time (§14.1); track the live process by sessionId, never by the first short id
  const live = (await spikeAgents()).find((a) => a.sessionId === row.sessionId && a.state === "working");
  if (live) { await sh(["claude", "stop", live.id], { timeoutMs: 15_000 }); await waitFor(async () => !peerSocketFor(row.sessionId), 20_000).catch(() => null); }
  const r = parseBg((await sh(["claude", "--bg", "--resume", row.sessionId, "-n", "relay-spike:matrix", "--settings", settings(PORT), `[relay #${marker}] ${text}`], { cwd: row.cwd, timeoutMs: 60_000 })).stdout);
  return r ? "accepted" : "unknown";
}
const arrived = async (marker: string) => waitFor(async () => hookLines(LOG).some((l) => l.e === "UserPromptSubmit" && String(l.body.prompt).includes(`[relay #${marker}]`)), 60_000).then(() => true).catch(() => false);
// busy
await waitFor(async () => hookLines(LOG).some((l) => l.e === "PreToolUse" && l.body.tool_name === "Bash"), 60_000);
results.busy = (await send("busy0001", "after the current command, reply BUSY-ACK")) + "/" + (await arrived("busy0001") ? "arrived" : "not-arrived");
// idle
await waitFor(async () => hookLines(LOG).some((l) => l.e === "Stop"), 120_000);
results.idle = (await send("idle0001", "reply IDLE-ACK")) + "/" + (await arrived("idle0001") ? "arrived" : "not-arrived");
// burst 10 to idle
await waitFor(async () => hookLines(LOG).filter((l) => l.e === "Stop").length >= 3, 180_000);   // wait for the idle-send turn to finish too
const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => send(`burst00${i}`, `reply B${i}`)));
const burstArrived = (await Promise.all(Array.from({ length: 10 }, (_, i) => arrived(`burst00${i}`)))).filter(Boolean).length;
results.burst = `${burst.join(",")} arrived:${burstArrived}/10`;
// stopped
await Bun.sleep(3000); { const live = (await spikeAgents()).find((a) => a.sessionId === row.sessionId && a.state === "working"); if (live) await sh(["claude", "stop", live.id], { timeoutMs: 15_000 }); }
await sh(["claude", "stop", bg.short], { timeoutMs: 15_000 });
await waitFor(async () => !peerSocketFor(row.sessionId), 20_000).catch(() => null);
const rs = parseBg((await sh(["claude", "--bg", "--resume", row.sessionId, "-n", "relay-spike:matrix", "--settings", settings(PORT), "[relay #stop0001] reply STOP-ACK"], { cwd: row.cwd, timeoutMs: 60_000 })).stdout);
results.stopped = (rs ? "accepted" : "unknown") + "/" + (await arrived("stop0001") ? "arrived" : "not-arrived");
record({ deliveryMatrix: results, deliveryMethodTested: delivery, socketAck: acks.every((a: any) => a.replies.length === 0) ? "none — receiver never answers on the socket" : acks });
for (const [k, v] of Object.entries(results)) check(`delivery ${k}`, String(v).endsWith("/arrived") || k === "burst", v);   // "busy/arrived" etc. — a substring match would accept "not-arrived"
check("delivery burst 10/10 arrived", burstArrived === 10, results.burst);
for (const a of (await spikeAgents(true)).filter((a) => a.sessionId === row.sessionId)) await stopAndRm(a.id);
killHookds();
