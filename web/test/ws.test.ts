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
  test("the server promises the frame cursor, so a frameless event cannot strand the replay", async () => {
    store.reset();
    connect({ url: "ws://y/ws", WebSocketImpl: FakeWS as any, fetchImpl: (async () => ({ ok: true, json: async () => snapshot })) as any });
    await new Promise((r) => setTimeout(r, 5));
    FakeWS.last.emit({ seq: 5, idx: 0, type: "hello", as_of_seq: 5, state: {} });                  // first load: snapshot
    await new Promise((r) => setTimeout(r, 5));
    FakeWS.last.close(); await new Promise((r) => setTimeout(r, 1100));                            // reconnect
    // seq 8 is system.recovered and produces no frame, so the server's as_of_seq is 7 — the last seq that did.
    FakeWS.last.emit({ seq: 8, idx: 0, type: "hello", as_of_seq: 7, state: {} });
    expect(store.state.conn).toBe("resync");
    FakeWS.last.emit({ seq: 7, idx: 0, type: "chat.message", message: { id: "r1", created_at: 9 } });
    expect(store.state.conn).toBe("ok"); expect(store.state.seq).toBe(7);                          // reached the promise exactly, no timer involved
  });
  test("a hello whose as_of_seq the cursor already covers goes straight to ok", async () => {
    FakeWS.last.close(); await new Promise((r) => setTimeout(r, 1100));
    FakeWS.last.emit({ seq: 7, idx: 0, type: "hello", as_of_seq: 7, state: {} });
    expect(store.state.conn).toBe("ok");
  });
});

describe("snapshot failure recovery", () => {
  test("an HTTP failure closes the socket and retries initial sync", async () => {
    store.reset(); let requests = 0;
    const stop = connect({ url: "ws://failure/ws", WebSocketImpl: FakeWS as any, fetchImpl: (async () => ++requests === 1
      ? { ok: false, status: 503, json: async () => ({}) }
      : { ok: true, json: async () => snapshot }) as any });
    try {
      await FakeWS.last.onmessage({ data: JSON.stringify({ seq: 5, idx: 0, type: "hello", as_of_seq: 5, state: {} }) });
      expect(store.state.conn).toBe("reconnecting");
      await Bun.sleep(1100);
      expect(FakeWS.last.url).not.toContain("from_seq");
      await FakeWS.last.onmessage({ data: JSON.stringify({ seq: 5, idx: 0, type: "hello", as_of_seq: 5, state: {} }) });
      expect(requests).toBe(2); expect(store.state.conn).toBe("ok");
    } finally { stop(); }
  });
  test("a late snapshot from a disconnected socket cannot roll back the current state", async () => {
    store.reset(); let finishOld!: (r: any) => void; let requests = 0;
    const stop = connect({ url: "ws://race/ws", WebSocketImpl: FakeWS as any, fetchImpl: (() => ++requests === 1
      ? new Promise(r => { finishOld = r; })
      : Promise.resolve({ ok: true, json: async () => ({ ...snapshot, as_of_seq: 20 }) })) as any });
    try {
      const old = FakeWS.last;
      const pending = old.onmessage({ data: JSON.stringify({ seq: 5, idx: 0, type: "hello", as_of_seq: 5, state: {} }) });
      old.close(); await Bun.sleep(1100);
      await FakeWS.last.onmessage({ data: JSON.stringify({ seq: 20, idx: 0, type: "hello", as_of_seq: 20, state: {} }) });
      finishOld({ ok: true, json: async () => snapshot }); await pending;
      expect(store.state.seq).toBe(20); expect(store.state.conn).toBe("ok");
    } finally { stop(); }
  });
});

test("a stalled snapshot closes its socket and retries even when fetch never settles", async () => {
  store.reset(); let requests = 0; let signal!: AbortSignal;
  const stop = connect({ url: "ws://stalled/ws", WebSocketImpl: FakeWS as any, snapshotTimeoutMs: 20,
    fetchImpl: ((_url: string, init: RequestInit) => { signal = init.signal!; requests++;
      return requests === 1 ? new Promise(() => {}) : Promise.resolve({ ok: true, json: async () => snapshot }); }) as any });
  try {
    const old = FakeWS.last;
    void old.onmessage({ data: JSON.stringify({ seq: 5, idx: 0, type: "hello", as_of_seq: 5, state: {} }) });
    await Bun.sleep(50);
    expect(signal.aborted).toBe(true); expect(store.state.conn).toBe("reconnecting");
    await Bun.sleep(1100); expect(FakeWS.last).not.toBe(old);
    await FakeWS.last.onmessage({ data: JSON.stringify({ seq: 5, idx: 0, type: "hello", as_of_seq: 5, state: {} }) });
    expect(requests).toBe(2); expect(store.state.conn).toBe("ok");
  } finally { stop(); }
});
