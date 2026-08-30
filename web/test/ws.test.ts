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

// --- QA (2026-08-31): a restart emits system.recovered, an event that carries no frame at all ---
describe("ws resync completion", () => {
  test("resync ends when the replay burst stops, even if no frame ever reaches as_of_seq", async () => {
    store.reset();
    connect({ url: "ws://y/ws", WebSocketImpl: FakeWS as any, fetchImpl: (async () => ({ ok: true, json: async () => snapshot })) as any, resyncIdleMs: 120 });
    await new Promise((r) => setTimeout(r, 5));
    FakeWS.last.emit({ seq: 5, idx: 0, type: "hello", as_of_seq: 5, state: {} });                  // first load: snapshot
    await new Promise((r) => setTimeout(r, 5));
    FakeWS.last.close(); await new Promise((r) => setTimeout(r, 1100));                            // reconnect
    FakeWS.last.emit({ seq: 8, idx: 0, type: "hello", as_of_seq: 8, state: {} });
    FakeWS.last.emit({ seq: 7, idx: 0, type: "chat.message", message: { id: "r1", created_at: 9 } });
    expect(store.state.conn).toBe("resync");                                                       // seq 7 < as_of_seq 8, and seq 8 (system.recovered) will never arrive as a frame
    await new Promise((r) => setTimeout(r, 200));
    expect(store.state.conn).toBe("ok"); expect(store.state.seq).toBe(7);                          // the cursor did not move — the banner cleared anyway
  });
  test("a hello whose as_of_seq the cursor already covers goes straight to ok", async () => {
    FakeWS.last.close(); await new Promise((r) => setTimeout(r, 1100));
    FakeWS.last.emit({ seq: 7, idx: 0, type: "hello", as_of_seq: 7, state: {} });
    expect(store.state.conn).toBe("ok");
  });
});
