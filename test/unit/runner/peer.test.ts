import { describe, expect, test } from "bun:test";
import { buildFrame, frameText, loadPeerFixture, markersIn, parseStatus, sendFrame, sessionIdForSocket, socketPathForSession } from "../../../src/runner/peer.ts";
import { mkdtempSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const fixture = { inbound: [{ raw: "", lines: [{ type: "peer_message", msg_id: "m0", from: "uds:/tmp/cc-socks/1.sock", from_name: "a", from_session: "s0", text: "ping 1" }] }], ack: [{ sent: {}, replies: [{ type: "peer_message_status", orig_msg_id: "m0", status: "accepted" }] }] };
describe("peer", () => {
  test("buildFrame keeps fixture keys and substitutes values", () => {
    const f: any = buildFrame(fixture, { msgId: "m1", text: "hello", fromSocket: "/tmp/cc-socks/9.sock", fromName: "relay", fromSession: "rs" });
    expect(Object.keys(f).sort()).toEqual(["from", "from_name", "from_session", "msg_id", "text", "type"]); expect(f.msg_id).toBe("m1"); expect(f.text).toBe("hello"); expect(f.from).toBe("uds:/tmp/cc-socks/9.sock");
  });
  test("buildFrame against the measured fixture wraps the text in a cross-session envelope", () => {
    const fx = loadPeerFixture(join(import.meta.dir, "../../fixtures/peer-frames.json"))!;
    const f: any = buildFrame(fx, { msgId: "m2", text: "[relay #0000abcd] go", fromSocket: "/tmp/cc-socks/9.sock", fromName: "relay", fromSession: "rs" });
    expect(Object.keys(f).sort()).toEqual(["from", "message", "msgV", "msg_id", "priority", "type"]);
    expect(f.msg_id).toBe("m2"); expect(f.message.role).toBe("user"); expect(f.priority).toBe("next");
    expect(f.message.content).toBe('<cross-session-message from="uds:/tmp/cc-socks/9.sock" from-name="relay" from-mode="prompting">\n[relay #0000abcd] go\n</cross-session-message>');
  });
  test("a reply frame is attributed through the session registry, never by from-name, and yields our markers", () => {
    // measured reply shape: top-level `from`, a FRESH msg_id, no session id, no in-reply-to; `hop-chain` lives in the envelope
    const dir = mkdtempSync(join(tmpdir(), "relay-sessions-"));
    writeFileSync(join(dir, "4242.json"), JSON.stringify({ pid: 4242, sessionId: "sid-worker", messagingSocketPath: "/tmp/cc-socks/4242.sock", name: "shared-name" }));
    writeFileSync(join(dir, "4243.json"), JSON.stringify({ pid: 4243, sessionId: "sid-other", messagingSocketPath: "/tmp/cc-socks/4243.sock", name: "shared-name" }));
    const reply = { msgV: 1, msg_id: "fresh-id", type: "user", priority: "next", from: "uds:/tmp/cc-socks/4242.sock", message: { role: "user", content: '<cross-session-message from="uds:/tmp/cc-socks/4242.sock" hop-chain="abc" from-name="shared-name" from-mode="prompting">\n[relay #0000abcd] ok\n</cross-session-message>' } };
    expect(sessionIdForSocket(reply.from, dir)).toBe("sid-worker");
    expect(sessionIdForSocket("uds:/tmp/cc-socks/9999.sock", dir)).toBe(null);   // orphan: nothing owns that socket
    expect(markersIn(frameText(reply))).toEqual(["0000abcd"]);
    expect(markersIn(frameText({ text: "no marker here" }))).toEqual([]);
    expect(socketPathForSession("sid-worker", dir)).toBe("/tmp/cc-socks/4242.sock");   // background rows have no pid: the socket is found by session id
    expect(socketPathForSession("sid-missing", dir)).toBe(null);
  });
  test("parseStatus", () => {
    expect(parseStatus([{ type: "peer_message_status", status: "accepted" }])).toBe("accepted"); expect(parseStatus([{ type: "peer_message_status", status: "held" }])).toBe("held");
    expect(parseStatus([{ type: "peer_message_status", status: "refused" }])).toBe("refused"); expect(parseStatus([])).toBe("unknown");
  });
  test("sendFrame against a fake inbox returns the replied status", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "relay-sock-")), "w.sock");
    const srv = Bun.listen({ unix: sock, socket: { data(s, b) { const m = JSON.parse(b.toString().split("\n")[0]); s.write(JSON.stringify({ type: "peer_message_status", orig_msg_id: m.msg_id, status: "accepted" }) + "\n"); s.end(); } } });
    const r = await sendFrame(sock, { type: "peer_message", msg_id: "x", text: "hi" }, 2000); expect(r.outcome).toBe("accepted"); srv.stop();
    expect((await sendFrame(join(tmpdir(), "nope.sock"), { msg_id: "y" }, 500)).outcome).toBe("unknown");
  });
  test("a silent inbox (the measured Claude behaviour) leaves the send `unknown` — the marker promotes it later", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "relay-sock-")), "s.sock");
    const srv = Bun.listen({ unix: sock, socket: { data() {} } });
    expect((await sendFrame(sock, { type: "peer_message", msg_id: "q", text: "hi" }, 300)).outcome).toBe("unknown"); srv.stop();
  });
  test("sendFrame reassembles fragmented lines and ignores status frames addressed to other msg_ids", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "relay-sock-")), "f.sock");
    const other = JSON.stringify({ type: "peer_message_status", orig_msg_id: "other", status: "refused" }) + "\n"; const mine = JSON.stringify({ type: "peer_message_status", orig_msg_id: "z", status: "held" }) + "\n";
    const srv = Bun.listen({ unix: sock, socket: { data(s) { s.write(other + mine.slice(0, 12)); setTimeout(() => s.write(mine.slice(12)), 20); } } });
    const r = await sendFrame(sock, { type: "peer_message", msg_id: "z", text: "hi" }, 2000); expect(r.outcome).toBe("held"); srv.stop();
  });
});
