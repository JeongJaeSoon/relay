import type { WsFrame, TasksSnapshot } from "@shared/types.ts";
import { readToken } from "./consts.ts";
import { store } from "./store.ts";
/** hello → (first load or far behind) snapshot + buffered frames | (reconnect) replay until seq reaches hello.as_of_seq → live. The cursor only moves with applied frames. */
export function connect(opts: { url?: string; WebSocketImpl?: typeof WebSocket; fetchImpl?: typeof fetch } = {}) {
  const WS = opts.WebSocketImpl ?? WebSocket; const f = opts.fetchImpl ?? fetch; const token = readToken(); const tok = encodeURIComponent(token);
  const base = opts.url ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  let backoff = 1000; let first = true;
  const open = () => {
    const ws = new WS(first ? `${base}?token=${tok}` : `${base}?from_seq=${Math.max(0, store.state.seq - 1)}&token=${tok}`);   // no from_seq on first load (the snapshot covers history); on reconnect re-request the last event — its frames are filtered by the (seq, idx) cursor
    let buffering = first; const buf: WsFrame[] = []; let asOf = -1;
    ws.onopen = () => { backoff = 1000; };
    ws.onmessage = async (ev) => {
      const fr = JSON.parse(String(ev.data)) as WsFrame;
      if (fr.type === "hello") {
        const behind = fr.as_of_seq - store.state.seq; store.applyFrame(fr);
        if (first || behind > 5000) {                                          // (re)load the snapshot, then apply what arrived meanwhile
          buffering = true; const r = await f("/api/tasks", { headers: { authorization: `Bearer ${token}` } }); const snap = (await r.json()) as TasksSnapshot; store.applySnapshot(snap);
          for (const b of buf) if (b.seq > snap.as_of_seq) store.applyFrame(b); buf.length = 0; buffering = false; first = false; store.setConn("ok");
        } else if (store.state.seq >= fr.as_of_seq) { store.setConn("ok"); } else { asOf = fr.as_of_seq; store.setConn("resync"); }   // as_of_seq is the server's frame cursor, so the replay always reaches it
        return;
      }
      if (buffering) buf.push(fr); else { store.applyFrame(fr); if (asOf >= 0 && store.state.seq >= asOf) { asOf = -1; store.setConn("ok"); } }
    };
    ws.onclose = () => { asOf = -1; store.setConn("reconnecting"); setTimeout(open, backoff); backoff = Math.min(backoff * 2, 15_000); };
  };
  open();
}
