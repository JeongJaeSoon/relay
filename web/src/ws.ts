import type { WsFrame, TasksSnapshot } from "@shared/types.ts";
import { readToken } from "./consts.ts";
import { store } from "./store.ts";
/** hello → (first load or far behind) snapshot + buffered frames | (reconnect) replay until seq reaches hello.as_of_seq → live. The cursor only moves with applied frames. */
const RESYNC_IDLE_MS = 1000;
export function connect(opts: { url?: string; WebSocketImpl?: typeof WebSocket; fetchImpl?: typeof fetch; resyncIdleMs?: number } = {}) {
  const idleMs = opts.resyncIdleMs ?? RESYNC_IDLE_MS;
  const WS = opts.WebSocketImpl ?? WebSocket; const f = opts.fetchImpl ?? fetch; const token = readToken(); const tok = encodeURIComponent(token);
  const base = opts.url ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  let backoff = 1000; let first = true;
  const open = () => {
    const ws = new WS(first ? `${base}?token=${tok}` : `${base}?from_seq=${Math.max(0, store.state.seq - 1)}&token=${tok}`);   // no from_seq on first load (the snapshot covers history); on reconnect re-request the last event — its frames are filtered by the (seq, idx) cursor
    let buffering = first; const buf: WsFrame[] = []; let asOf = -1; let idle: ReturnType<typeof setTimeout> | undefined;
    // Not every seq produces a frame — an event with no task and no projection frame (system.recovered, emitted on
    // every start) carries none — so the cursor can never reach as_of_seq and `resync` would stick forever. The
    // replay is also over when the burst stops.
    const caughtUp = () => { if (asOf < 0) return; asOf = -1; clearTimeout(idle); store.setConn("ok"); };
    const armIdle = () => { clearTimeout(idle); idle = setTimeout(caughtUp, idleMs); };
    ws.onopen = () => { backoff = 1000; };
    ws.onmessage = async (ev) => {
      const fr = JSON.parse(String(ev.data)) as WsFrame;
      if (fr.type === "hello") {
        const behind = fr.as_of_seq - store.state.seq; store.applyFrame(fr);
        if (first || behind > 5000) {                                          // (re)load the snapshot, then apply what arrived meanwhile
          buffering = true; const r = await f("/api/tasks", { headers: { authorization: `Bearer ${token}` } }); const snap = (await r.json()) as TasksSnapshot; store.applySnapshot(snap);
          for (const b of buf) if (b.seq > snap.as_of_seq) store.applyFrame(b); buf.length = 0; buffering = false; first = false; store.setConn("ok");
        } else if (store.state.seq >= fr.as_of_seq) { store.setConn("ok"); } else { asOf = fr.as_of_seq; store.setConn("resync"); armIdle(); }
        return;
      }
      if (buffering) buf.push(fr); else { store.applyFrame(fr); if (asOf >= 0) { if (store.state.seq >= asOf) caughtUp(); else armIdle(); } }
    };
    ws.onclose = () => { clearTimeout(idle); asOf = -1; store.setConn("reconnecting"); setTimeout(open, backoff); backoff = Math.min(backoff * 2, 15_000); };
  };
  open();
}
