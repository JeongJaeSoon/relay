import { describe, expect, test } from "bun:test";
import { connect } from "../src/ws.ts";
import { store } from "../src/store.ts";
class FakeWS { static last: FakeWS; onopen: any; onmessage: any; onclose: any; url: string; constructor(url: string) { this.url = url; FakeWS.last = this; setTimeout(() => this.onopen?.(), 0); } send() {} close() { this.onclose?.({}); } emit(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); } }
const snapshot = { as_of_seq: 5, tasks: [], projects: [], state: { paused: false }, messages: [] };
describe("ws client", () => {
  test("first connection: no from_seq (live only); frames buffer until the snapshot, then only seq > as_of_seq apply", async () => {
    store.reset();
    let resolveFetch!: (v: unknown) => void; const fetchImpl = (() => new Promise((r) => (resolveFetch = r))) as any;
    connect({ url: "ws://x/ws", WebSocketImpl: FakeWS as any, fetchImpl });
    await new Promise((r) => setTimeout(r, 5));
    expect(FakeWS.last.url).not.toContain("from_seq");
    FakeWS.last.emit({ seq: 5, idx: 0, type: "hello", as_of_seq: 5, state: {} }); FakeWS.last.emit({ seq: 4, idx: 0, type: "chat.message", message: { id: "old", created_at: 1 } }); FakeWS.last.emit({ seq: 6, idx: 0, type: "chat.message", message: { id: "new", created_at: 2 } });
    expect(store.state.messages.length).toBe(0);                                  // still buffering
    resolveFetch({ ok: true, json: async () => snapshot }); await new Promise((r) => setTimeout(r, 5));
    expect(store.state.messages.map((m) => m.id)).toEqual(["new"]); expect(store.state.seq).toBe(6); expect(store.state.conn).toBe("ok");
  });
  test("reconnect asks from_seq = seq-1 (the last event is re-sent and filtered by the cursor), shows resync until caught up, and hello never drops replayed frames", async () => {
    FakeWS.last.close(); expect(store.state.conn).toBe("reconnecting");
    await new Promise((r) => setTimeout(r, 1100)); expect(FakeWS.last.url).toContain("from_seq=5");
    FakeWS.last.emit({ seq: 8, idx: 0, type: "hello", as_of_seq: 8, state: {} }); expect(store.state.conn).toBe("resync");
    FakeWS.last.emit({ seq: 6, idx: 0, type: "chat.message", message: { id: "new", created_at: 2 } }); expect(store.state.seq).toBe(6);   // re-sent last event: dropped by the cursor
    FakeWS.last.emit({ seq: 7, idx: 0, type: "chat.message", message: { id: "n2", created_at: 3 } }); expect(store.state.conn).toBe("resync");
    FakeWS.last.emit({ seq: 8, idx: 0, type: "chat.message", message: { id: "n3", created_at: 4 } });
    expect(store.state.messages.map((m) => m.id)).toEqual(["new", "n2", "n3"]); expect(store.state.conn).toBe("ok");
  });
});
