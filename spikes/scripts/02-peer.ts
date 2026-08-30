// spikes/scripts/02-peer.ts — register this process as a Claude Code messaging peer and log/send raw socket frames.
// usage: bun spikes/scripts/02-peer.ts            (registers as "relay-spike" and listens; type JSON lines on stdin to send)
//   stdin: {"to":"/tmp/cc-socks/<pid>.sock","text":"hello"}      → sends a frame built from spikes/fixtures/peer-frames.json (or a guess) and logs replies
//   stdin: {"raw":"/tmp/cc-socks/<pid>.sock","line":"{...}"}      → sends an arbitrary raw line
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FIXTURES, RESULTS, sh } from "./lib.ts";

const pid = process.pid;
const sockDir = existsSync("/tmp/cc-socks") ? "/tmp/cc-socks" : `/tmp/cc-socks-${process.getuid?.() ?? 501}`;
mkdirSync(sockDir, { recursive: true, mode: 0o700 });
const sockPath = join(sockDir, `${pid}.sock`);
const regDir = join(homedir(), ".claude", "sessions"); mkdirSync(regDir, { recursive: true });
const regPath = join(regDir, `${pid}.json`);
const procStart = (await sh(["ps", "-o", "lstart=", "-p", String(pid)])).stdout.trim();
const version = (await sh(["claude", "--version"])).stdout.trim().split(" ")[0];
const registry = {
  pid, sessionId: crypto.randomUUID(), cwd: process.cwd(), startedAt: Date.now(), procStart, version,
  peerProtocol: 1, peerFeatures: ["notify_idle"], kind: "bg", entrypoint: "cli", pidDomain: "darwin",
  messagingSocketPath: sockPath, name: "relay-spike", nameSince: Date.now(), nameSource: "user", status: "idle", updatedAt: Date.now(), statusUpdatedAt: Date.now(),
};
writeFileSync(regPath, JSON.stringify(registry, null, 1), { mode: 0o600 });
const LOG = join(RESULTS, "02-peer.jsonl");
const fx = join(FIXTURES, "peer-frames.json");
const frames = existsSync(fx) ? JSON.parse(readFileSync(fx, "utf8")) : { inbound: [], ack: [], registry };
const save = () => writeFileSync(fx, JSON.stringify({ ...frames, registry }, null, 2) + "\n");
try { unlinkSync(sockPath); } catch {}

Bun.listen({
  unix: sockPath,
  socket: {
    open() { appendFileSync(LOG, JSON.stringify({ t: Date.now(), ev: "open" }) + "\n"); },
    data(sock, buf) {
      const raw = buf.toString();
      const lines = raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { unparsed: l }; } });
      appendFileSync(LOG, JSON.stringify({ t: Date.now(), ev: "data", raw, lines }) + "\n");
      frames.inbound.push({ raw, lines }); save();
      // Reply with a status frame guess so we learn whether the sender waits for one. Adjust keys after the first capture.
      const msgId = lines.find((l: any) => l.msg_id)?.msg_id ?? lines.find((l: any) => l.id)?.id;
      if (msgId) sock.write(JSON.stringify({ type: "peer_message_status", orig_msg_id: msgId, status: "accepted" }) + "\n");
    },
    close() { appendFileSync(LOG, JSON.stringify({ t: Date.now(), ev: "close" }) + "\n"); },
  },
});
console.log(`peer registered: ${regPath}\nlistening: ${sockPath}\nIn a Claude session run: SendMessage to "relay-spike" with any text. Frames → ${LOG}`);

process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  for (const line of String(chunk).split("\n").filter(Boolean)) {
    const cmd = JSON.parse(line);
    const target = cmd.to ?? cmd.raw;
    // Measured inbound shape (2026-08-30): the frame carries the text inside message.content, wrapped in a
    // <cross-session-message from=… from-name=… from-mode=…> element. Mirror it exactly when sending.
    const text = cmd.text ?? "hello from relay-spike";
    const outbound = {
      msgV: 1, msg_id: crypto.randomUUID(), type: "user",
      message: { role: "user", content: `<cross-session-message from="uds:${sockPath}" from-name="relay-spike" from-mode="prompting">\n${text}\n</cross-session-message>` },
      priority: "next", from: `uds:${sockPath}`,
    };
    const frame = cmd.line ?? JSON.stringify(outbound);
    const replies: unknown[] = [];
    const t0 = Date.now();
    await new Promise<void>((resolve) => {
      Bun.connect({ unix: target, socket: {
        open(s) { s.write(frame + "\n"); setTimeout(() => { s.end(); resolve(); }, 8000); },
        data(_s, b) { for (const l of b.toString().split("\n").filter(Boolean)) { try { replies.push(JSON.parse(l)); } catch { replies.push({ unparsed: l }); } } },
        close() { resolve(); }, error(_s, e) { replies.push({ error: String(e) }); resolve(); },
      } }).catch((e) => { replies.push({ error: String(e) }); resolve(); });
    });
    const rec = { t: Date.now(), ev: "sent", target, frame, replies, wait_ms: Date.now() - t0 };
    appendFileSync(LOG, JSON.stringify(rec) + "\n"); frames.ack.push({ sent: JSON.parse(frame), replies }); save();
    console.log("replies:", JSON.stringify(replies));
  }
}
process.on("exit", () => { try { unlinkSync(regPath); unlinkSync(sockPath); } catch {} });
