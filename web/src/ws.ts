import type { WsFrame, TasksSnapshot } from "@shared/types.ts";
import { readToken } from "./consts.ts";
import { store } from "./store.ts";
/** hello → (first load or far behind) snapshot + buffered frames | (reconnect) replay until seq reaches hello.as_of_seq → live. The cursor only moves with applied frames. */
export function connect(opts: { url?: string; WebSocketImpl?: typeof WebSocket; fetchImpl?: typeof fetch } = {}) {
  const WS = opts.WebSocketImpl ?? WebSocket; const f = opts.fetchImpl ?? fetch; const token = readToken(); const tok = encodeURIComponent(token);
  const base = opts.url ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  let backoff = 1000; let first = true; let stopped = false;
  let active: WebSocket; let retry: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    if (stopped) return;
    const ws = new WS(first ? `${base}?token=${tok}` : `${base}?from_seq=${Math.max(0, store.state.seq - 1)}&token=${tok}`);   // no from_seq on first load (the snapshot covers history); on reconnect re-request the last event — its frames are filtered by the (seq, idx) cursor
    active = ws; let closed = false; const abort = new AbortController();
    let buffering = first; const buf: WsFrame[] = []; let asOf = -1;
    ws.onopen = () => { backoff = 1000; };
    ws.onmessage = async (ev) => {
      if (closed || stopped) return;
      try {
      const fr = JSON.parse(String(ev.data)) as WsFrame;
      if (fr.type === "hello") {
        const behind = fr.as_of_seq - store.state.seq; store.applyFrame(fr);
        if (first || behind > 5000) {                                          // (re)load the snapshot, then apply what arrived meanwhile
          buffering = true; const r = await f("/api/tasks", { headers: { authorization: `Bearer ${token}` }, signal: abort.signal });
          if (!r.ok) throw new Error(`snapshot failed: ${r.status}`);
          const snap = (await r.json()) as TasksSnapshot;
          if (closed || stopped) return;   // an old fetch must never overwrite a newer connection's snapshot
          store.applySnapshot(snap);
          for (const b of buf) if (b.seq > snap.as_of_seq) store.applyFrame(b); buf.length = 0; buffering = false; first = false; store.setConn("ok");
        } else if (store.state.seq >= fr.as_of_seq) { store.setConn("ok"); } else { asOf = fr.as_of_seq; store.setConn("resync"); }   // as_of_seq is the server's frame cursor, so the replay always reaches it
        return;
      }
      if (buffering) buf.push(fr); else { store.applyFrame(fr); if (asOf >= 0 && store.state.seq >= asOf) { asOf = -1; store.setConn("ok"); } }
      } catch {
        if (!closed && !stopped) ws.close();   // failed initial sync retries through the same reconnect path
      }
    };
    ws.onclose = () => { if (closed) return; closed = true; abort.abort(); asOf = -1; if (stopped) return; store.setConn("reconnecting"); retry = setTimeout(open, backoff); backoff = Math.min(backoff * 2, 15_000); };
  };
  open();
  return () => { stopped = true; clearTimeout(retry); active?.close(); };
}
