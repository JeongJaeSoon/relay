// spikes/scripts/02-delivery-matrix.ts — deliver a message to a worker in each process state and record the outcome.
// states: busy (long Bash running), idle (after Stop), stopped (after claude stop) ; plus burst of 10 to an idle worker
//
// Adapted to what Task 2 Step 3 actually measured:
//  - the inbox socket cannot be derived from `agents --json` (background rows carry no pid); it comes from the session
//    registry ~/.claude/sessions/<pid>.json, matched on sessionId (lib.peerSocketFor).
//  - the receiver sends NO status frame back, so `accepted/held/refused` is not observable on the socket. The outcome
//    signal is the `[relay #…]` marker showing up in the worker's UserPromptSubmit hook (roadmap B3's fallback is the
//    only signal there is).
import { appendFileSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { caps, check, hookLines, killHookds, parseBg, peerFrame, peerRegistry, peerSocketFor, record, RESULTS, SANDBOX, settings, sh, socketSend, spawnHookd, spikeAgents, stopAndRm, waitFor } from "./lib.ts";
const PORT = 8793, LOG = join(RESULTS, "02-matrix.jsonl");
rmSync(LOG, { force: true });
spawnHookd(PORT, LOG); await Bun.sleep(500);
const delivery = caps().delivery ?? "resume";
const results: Record<string, string> = {};
const acks: unknown[] = [];

// The probe must LISTEN on the socket it puts in the frame's `from`. With a dead `from` socket the worker's reply
// ("BUSY-ACK", "B0"…) has nowhere to land and the CLI delivers it to some other registered peer — during the first
// run that was the orchestrator's own session. Listening here keeps every reply inside the spike and captures the
// reply frames as a bonus.
const SOCK_DIR = "/tmp/cc-socks";
mkdirSync(SOCK_DIR, { recursive: true, mode: 0o700 });
const selfSock = join(SOCK_DIR, `relay-spike-probe-${process.pid}.sock`);
const selfReg = join(homedir(), ".claude", "sessions", `${process.pid}.json`);
try { unlinkSync(selfSock); } catch {}
const replies: unknown[] = [];
Bun.listen({ unix: selfSock, socket: {
  data(_s, b) {
    const raw = b.toString();
    appendFileSync(LOG, JSON.stringify({ t: Date.now(), e: "ProbeReply", body: { raw } }) + "\n");
    for (const l of raw.split("\n").filter(Boolean)) { try { replies.push(JSON.parse(l)); } catch { replies.push({ unparsed: l }); } }
  },
} });
mkdirSync(join(homedir(), ".claude", "sessions"), { recursive: true });
writeFileSync(selfReg, JSON.stringify({ pid: process.pid, sessionId: crypto.randomUUID(), cwd: process.cwd(), startedAt: Date.now(),
  version: "2.1.251", peerProtocol: 1, peerFeatures: [], kind: "bg", entrypoint: "cli", pidDomain: "darwin",
  messagingSocketPath: selfSock, name: "relay-spike:probe", nameSource: "user", status: "idle", updatedAt: Date.now() }, null, 1), { mode: 0o600 });
const cleanupProbe = () => { try { unlinkSync(selfReg); } catch {} try { unlinkSync(selfSock); } catch {} };
process.on("exit", cleanupProbe);

const bg = parseBg((await sh(["claude", "--bg", "-n", "relay-spike:matrix", "--model", "claude-sonnet-5", "--effort", "low", "--permission-mode", "auto", "--settings", settings(PORT),
  "Run `sleep 3` fifteen times with Bash, as fifteen separate sequential calls, waiting for each one. Then reply DONE-1."], { cwd: SANDBOX, timeoutMs: 60_000 })).stdout)!;
const row = await waitFor(async () => (await spikeAgents()).find((a) => a.name === "relay-spike:matrix"), 30_000);

/** Never send to anything but this run's own spike worker: check the name on BOTH the agents row and the registry row. */
function assertSpikeTarget(sock: string) {
  if (!String(row.name).startsWith("relay-spike:")) throw new Error(`refusing to probe non-spike agent row: ${row.name}`);
  const reg = peerRegistry().find((r) => r.messagingSocketPath === sock);
  if (!reg) throw new Error(`refusing to probe ${sock}: no session registry entry`);
  if (reg.sessionId !== row.sessionId || !String(reg.name).startsWith("relay-spike:")) {
    throw new Error(`refusing to probe ${sock}: registry says name=${reg.name} sessionId=${reg.sessionId}, expected ${row.name} / ${row.sessionId}`);
  }
}
async function send(marker: string, text: string, holdMs = 45_000): Promise<string> {
  if (delivery === "socket") {
    const sock = await waitFor(async () => peerSocketFor(row.sessionId), 20_000).catch(() => null);
    if (!sock) return "no-socket";
    assertSpikeTarget(sock);
    // hold the connection open: a busy receiver only drains its inbox at a turn boundary, and closing early loses the frame
    const r = await socketSend(sock, peerFrame(selfSock, "relay-spike:probe", `[relay #${marker}] ${text}`), holdMs);
    acks.push({ marker, replies: r.replies, error: r.error });
    return r.error ? "error" : r.replies.length ? String((r.replies[0] as any).status ?? "reply") : "no-ack";
  }
  // resume issues a NEW short id each time (§14.1); track the live process by sessionId, never by the first short id
  const live = (await spikeAgents()).find((a) => a.sessionId === row.sessionId && a.state === "working");
  if (live) { await sh(["claude", "stop", live.id], { timeoutMs: 15_000 }); await waitFor(async () => !peerSocketFor(row.sessionId), 20_000).catch(() => null); }
  const r = parseBg((await sh(["claude", "--bg", "--resume", row.sessionId, "-n", "relay-spike:matrix", "--settings", settings(PORT), `[relay #${marker}] ${text}`], { cwd: row.cwd, timeoutMs: 60_000 })).stdout);
  return r ? "accepted" : "unknown";
}
// Two independent delivery signals, because they disagree:
//  - hook:  the `[relay #…]` marker in the worker's UserPromptSubmit. Only fires when the message STARTS a turn.
//           A frame merged into a turn that is already running produces no UserPromptSubmit at all.
//  - ack:   the worker's own reply frame arriving on the probe's inbox socket. This is the signal that actually
//           proves delivery, and it is the only one available for a mid-turn send.
const hookArrived = async (marker: string, ms = 60_000) => waitFor(async () => hookLines(LOG).some((l) => l.e === "UserPromptSubmit" && String(l.body.prompt).includes(`[relay #${marker}]`)), ms).then(() => true).catch(() => false);
const ackText = () => hookLines(LOG).filter((l) => l.e === "ProbeReply").map((l) => String(l.body.raw)).join("\n");
// plain includes, not a \b regex: body.raw is the raw socket line, so the reply text sits inside JSON escapes
// ("…prompting\">\\nIDLE-ACK\\n<…") and the char before the needle is the `n` of an escaped newline, which kills \b.
const ackArrived = async (needle: string, ms = 90_000) => waitFor(async () => ackText().includes(needle), ms).then(() => true).catch(() => false);
const both = async (marker: string, needle: string) => `hook:${await hookArrived(marker) ? "yes" : "no"}/ack:${await ackArrived(needle) ? "yes" : "no"}`;
// busy — the send must land INSIDE a running turn, which is the case C12 describes ("read between tool calls").
// A single long `sleep` is useless here: the Bash tool auto-backgrounds it and the turn ends immediately, which is
// how run B produced a bogus negative. Many short sequential calls keep the turn genuinely open instead.
await waitFor(async () => hookLines(LOG).filter((l) => l.e === "PostToolUse" && l.body.tool_name === "Bash").length >= 2, 90_000);
if (hookLines(LOG).some((l) => l.e === "Stop")) throw new Error("busy case invalid: the worker already ended its turn");
results.busy = (await send("busy0001", "after the current command, reply BUSY-ACK")) + "/" + (await both("busy0001", "BUSY-ACK"));
// idle
await waitFor(async () => hookLines(LOG).some((l) => l.e === "Stop"), 120_000);
results.idle = (await send("idle0001", "reply IDLE-ACK")) + "/" + (await both("idle0001", "IDLE-ACK"));
// burst 10 to idle
const stopsBeforeBurst = hookLines(LOG).filter((l) => l.e === "Stop").length;   // relative, not a fixed count: the
// number of turns before this point varies (a backgrounded tool adds a notification turn), and a fixed 3 stalls the run.
await waitFor(async () => hookLines(LOG).filter((l) => l.e === "Stop").length > stopsBeforeBurst, 180_000).catch(() => null);
const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => send(`burst00${i}`, `reply B${i}`)));
const burstHook = (await Promise.all(Array.from({ length: 10 }, (_, i) => hookArrived(`burst00${i}`)))).filter(Boolean).length;
const burstAck = (await Promise.all(Array.from({ length: 10 }, (_, i) => ackArrived(`B${i}`, 180_000)))).filter(Boolean).length;
results.burst = `${burst.join(",")} hook:${burstHook}/10 ack:${burstAck}/10`;
// stopped
await Bun.sleep(3000); { const live = (await spikeAgents()).find((a) => a.sessionId === row.sessionId && a.state === "working"); if (live) await sh(["claude", "stop", live.id], { timeoutMs: 15_000 }); }
await sh(["claude", "stop", bg.short], { timeoutMs: 15_000 });
await waitFor(async () => !peerSocketFor(row.sessionId), 20_000).catch(() => null);
const rs = parseBg((await sh(["claude", "--bg", "--resume", row.sessionId, "-n", "relay-spike:matrix", "--settings", settings(PORT), "[relay #stop0001] reply STOP-ACK"], { cwd: row.cwd, timeoutMs: 60_000 })).stdout);
// the stopped case delivers through `--bg --resume "<text>"`, a plain prompt rather than a peer frame, so the worker
// has no sender to answer: score it by the hook only. `ack` is meaningful for socket sends alone.
results.stopped = (rs ? "accepted" : "unknown") + `/hook:${await hookArrived("stop0001") ? "yes" : "no"}`;
record({ deliveryMatrix: results, deliveryMethodTested: delivery,
  socketAck: acks.every((a: any) => a.replies.length === 0) ? "none — receiver never answers on the connection it received the frame on" : acks,
  probeReplies: replies.length ? replies : "none — the worker sent nothing back to the probe's own inbox socket either" });
for (const [k, v] of Object.entries(results)) check(`delivery ${k}`, /ack:yes|hook:yes/.test(String(v)) || k === "burst", v);   // for socket sends the ack is the real proof; the hook only fires for a turn-starting message
check("delivery burst: all 10 acked", burstAck === 10, results.burst);
for (const a of (await spikeAgents(true)).filter((a) => a.sessionId === row.sessionId)) await stopAndRm(a.id);
killHookds(); cleanupProbe();
