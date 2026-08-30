// src/runner/peer.ts — inbox-socket client/server built from the Phase 0 ② fixture (peer-frames.json).
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SendOutcome } from "@shared/types.ts";
import { paths } from "../config.ts";
export type PeerFixture = { inbound: { lines: any[] }[]; ack?: { replies: any[] }[]; registry?: any };
export type OutboundFrame = Record<string, unknown> & { msg_id?: string };
/** Where the measured frame fixture may live: an explicit override, the relay home (`relay setup` copies it there), or a spike checkout. */
export const peerFixturePaths = (): string[] => [process.env.RELAY_PEER_FIXTURE, join(paths.home, "peer-frames.json"), join(process.cwd(), "spikes", "fixtures", "peer-frames.json")].filter((p): p is string => !!p);
export function loadPeerFixture(path?: string): PeerFixture | null {
  const file = path ?? peerFixturePaths().find((p) => existsSync(p));
  return file && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as PeerFixture) : null;
}
/** The CLI delivers a peer message to the worker's prompt inside this envelope (measured `socketInboundKeys`). */
const wrap = (p: { text: string; fromSocket: string; fromName: string }) => `<cross-session-message from="uds:${p.fromSocket}" from-name="${p.fromName}" from-mode="prompting">\n${p.text}\n</cross-session-message>`;
export function buildFrame(fx: PeerFixture, p: { msgId: string; text: string; fromSocket: string; fromName: string; fromSession: string }): OutboundFrame {
  const tpl: any = fx.inbound?.[0]?.lines.find((l) => l.text !== undefined || l.message !== undefined) ?? { type: "peer_message", msg_id: "", from: "", from_name: "", from_session: "", text: "" };
  const out: OutboundFrame = { ...tpl };
  for (const k of Object.keys(out)) {
    if (/msg_id|^id$/.test(k)) out[k] = p.msgId;
    else if (k === "text") out[k] = p.text;
    // the measured frame carries `message: { role, content }` with the envelope in `content`; a plain-string template takes the raw text
    else if (k === "message") out[k] = tpl.message && typeof tpl.message === "object" ? { ...tpl.message, role: tpl.message.role ?? "user", content: wrap(p) } : p.text;
    else if (k === "from" || k === "reply_to" || k === "from_address") out[k] = `uds:${p.fromSocket}`; else if (k === "from_name" || k === "from-name") out[k] = p.fromName;
    else if (k === "from_session" || k === "from-session") out[k] = p.fromSession; else if (k === "notify_when_idle") out[k] = false;
  }
  return out;
}
export function parseStatus(lines: any[]): SendOutcome {
  const st = lines.find((l) => l && /status/.test(String(l.type ?? "")))?.status ?? lines.find((l) => l?.status)?.status;
  if (!st) return "unknown"; if (/accept|deliver|ok/i.test(st)) return "accepted"; if (/held|hold|pending/i.test(st)) return "held"; if (/refus|drop|reject/i.test(st)) return "refused"; return "unknown";
}
/** Sends one JSON line and waits for the status frame whose orig_msg_id matches ours (frames may arrive fragmented or coalesced — a line buffer reassembles them).
 *  Phase 0 measured that a Claude inbox never answers on the socket, so the normal outcome here is `unknown`: the
 *  `[relay #…]` marker in the worker's UserPromptSubmit hook is the only delivery evidence (roadmap B3). */
export function sendFrame(socketPath: string, frame: OutboundFrame, timeoutMs = 8000): Promise<{ outcome: SendOutcome; replies: any[] }> {
  return new Promise((resolve) => {
    const replies: any[] = []; let done = false; let buf = "";
    const mine = (l: any) => l && (l.orig_msg_id == null || frame.msg_id == null || l.orig_msg_id === frame.msg_id);
    const finish = () => { if (!done) { done = true; resolve({ outcome: parseStatus(replies.filter(mine)), replies }); } };
    const timer = setTimeout(() => { finish(); }, timeoutMs);
    Bun.connect({ unix: socketPath, socket: {
      open(s) { s.write(JSON.stringify(frame) + "\n"); },
      data(s, b) { buf += b.toString(); let nl; while ((nl = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!l.trim()) continue; try { replies.push(JSON.parse(l)); } catch { replies.push({ unparsed: l }); } } if (parseStatus(replies.filter(mine)) !== "unknown") { clearTimeout(timer); s.end(); finish(); } },
      close() { clearTimeout(timer); finish(); }, error() { clearTimeout(timer); finish(); },
    } }).catch(() => { clearTimeout(timer); finish(); });
  });
}
/** Reply frames carry NO session id and NO in-reply-to (measured): only `from: "uds:/tmp/cc-socks/<pid>.sock"`. The
 *  sender is resolved through the session registry — `from-name` is not an identity (two live sessions shared a name in
 *  Phase 0 ⑦). Returns the sender's session id, or null when nothing owns that socket. */
export function sessionIdForSocket(from: string | null | undefined, dir = join(homedir(), ".claude", "sessions")): string | null {
  const path = String(from ?? "").replace(/^uds:/, ""); if (!path) return null;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try { const j = JSON.parse(readFileSync(join(dir, f), "utf8")); if (j?.messagingSocketPath === path && typeof j.sessionId === "string") return j.sessionId; } catch {}
    }
  } catch {}
  return null;
}
/** The inverse lookup, for sending: `agents --json` carries no pid for background rows (Phase 0 ④), so a worker's inbox
 *  socket is found by matching its session id in the registry, never by guessing `<pid>.sock`. */
export function socketPathForSession(sessionId: string | null | undefined, dir = join(homedir(), ".claude", "sessions")): string | null {
  if (!sessionId) return null;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try { const j = JSON.parse(readFileSync(join(dir, f), "utf8")); if (j?.sessionId === sessionId && typeof j.messagingSocketPath === "string") return j.messagingSocketPath; } catch {}
    }
  } catch {}
  return null;
}
/** Everything the session registry knows about the sessions currently on this machine, keyed by session id. For a
 *  session relay never spawned this is the only source of a real start time, a pid and the launch kind (`bg` vs a
 *  terminal): `agents --json` carries none of them for background rows (Phase 0 ④). One readdir, whatever the caller
 *  needs to look up. */
export function sessionRegistryIndex(dir = join(homedir(), ".claude", "sessions")): Map<string, { pid: number | null; started_at: number | null; kind: string | null }> {
  const out = new Map<string, { pid: number | null; started_at: number | null; kind: string | null }>();
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
        if (typeof j?.sessionId === "string") out.set(j.sessionId, { pid: typeof j.pid === "number" ? j.pid : null, started_at: typeof j.startedAt === "number" ? j.startedAt : null, kind: typeof j.kind === "string" ? j.kind : null });
      } catch {}
    }
  } catch {}
  return out;
}

/** The text a peer frame carries, whichever shape it arrived in. */
export const frameText = (f: any): string => String(f?.message?.content ?? f?.message ?? f?.text ?? "");
/** Our `[relay #<id8>]` markers inside a frame — the only per-send correlation that exists (the reply's `msg_id` is
 *  fresh and there is no in-reply-to field; `hop-chain` is stable across a whole chain, so it is loop detection only). */
export const markersIn = (text: string): string[] => [...new Set((text.match(/\[relay #([0-9a-f]{8})\]/g) ?? []).map((m) => m.slice(8, 16)))];

/** relay registers itself as a peer so workers can reply / notify_when_idle. Mirrors the registry shape captured in the fixture. */
export class PeerServer {
  private server: ReturnType<typeof Bun.listen> | null = null; socketPath = ""; registryPath = "";
  constructor(private name: string, private sessionId: string, private onMessage: (frame: any, reply: (f: object) => void) => void) {}
  async start() {
    const dir = existsSync("/tmp/cc-socks") ? "/tmp/cc-socks" : `/tmp/cc-socks-${process.getuid?.() ?? 501}`; mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.socketPath = join(dir, `${process.pid}.sock`); this.registryPath = join(homedir(), ".claude", "sessions", `${process.pid}.json`); mkdirSync(join(homedir(), ".claude", "sessions"), { recursive: true });
    try { unlinkSync(this.socketPath); } catch {}
    const procStart = new TextDecoder().decode(Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(process.pid)]).stdout).trim();
    const fx = loadPeerFixture(); const reg = { ...(fx?.registry ?? {}), pid: process.pid, sessionId: this.sessionId, cwd: process.cwd(), startedAt: Date.now(), procStart, peerProtocol: 1, peerFeatures: ["notify_idle"], kind: "bg", entrypoint: "cli", pidDomain: "darwin", messagingSocketPath: this.socketPath, name: this.name, nameSince: Date.now(), nameSource: "user", status: "idle", updatedAt: Date.now(), statusUpdatedAt: Date.now() };
    writeFileSync(this.registryPath, JSON.stringify(reg, null, 1), { mode: 0o600 });
    const bufs = new WeakMap<object, string>();
    this.server = Bun.listen({ unix: this.socketPath, socket: { data: (s, b) => {
      let buf = (bufs.get(s) ?? "") + b.toString(); let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!l.trim()) continue;
        let f: any; try { f = JSON.parse(l); } catch { continue; }
        if (f.type === "auth") continue;                                  // macOS: optional; we accept our own user's connections (socket is 0600)
        this.onMessage(f, (r) => s.write(JSON.stringify(r) + "\n")); const id = f.msg_id ?? f.id; if (id) s.write(JSON.stringify({ type: "peer_message_status", orig_msg_id: id, status: "accepted" }) + "\n");
      }
      bufs.set(s, buf);
    } } });
    try { chmodSync(this.socketPath, 0o600); } catch {}
    return { socketPath: this.socketPath, registryPath: this.registryPath };
  }
  stop() { this.server?.stop(); try { unlinkSync(this.socketPath); unlinkSync(this.registryPath); } catch {} }
}
