// src/runner/peer.ts — session inbox socket client (roadmap C3, delivery = "socket").
//
// PLACEHOLDER: Task 17 implements this against spikes/fixtures/peer-frames.json. Only NativeSessionRunner's optional
// `peer` option reaches it, and nothing wires that option before Task 18, so every current caller and test is unaffected.
import type { SendOutcome } from "@shared/types.ts";

/** The measured frame shape (spikes/fixtures/peer-frames.json): `{ inbound, ack, registry }`. */
export interface PeerFixture { inbound?: unknown; ack?: unknown; registry?: unknown }
export interface PeerFrame { msgV: number; msg_id: string; type: string; message: { role: string; content: string }; priority: string; from: string }

export function buildFrame(_fixture: PeerFixture, _p: { msgId: string; text: string; fromSocket: string; fromName: string; fromSession: string }): PeerFrame {
  throw new Error("runner/peer.ts: buildFrame is implemented in Task 17");
}
export function sendFrame(_socketPath: string, _frame: PeerFrame): Promise<{ outcome: SendOutcome }> {
  throw new Error("runner/peer.ts: sendFrame is implemented in Task 17");
}
