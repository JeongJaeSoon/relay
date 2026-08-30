import type { Database } from "bun:sqlite";
import type { ForeignSession, WsFrame } from "@shared/types.ts";
import type { Config } from "../config.ts";
import type { EventLog } from "../core/events.ts";
import { systemState } from "../core/projections.ts";
type Sock = { send(s: string): void; readyState?: number };
export class WsHub {
  private clients = new Set<Sock>();
  constructor(private getLog: () => EventLog, private cfg: Config, private db: Database, private foreign: () => ForeignSession[] = () => []) {}
  /** Sessions relay does not own belong to no event, so this frame carries no usable cursor — the client applies it
   *  without moving (seq, idx). It is stamped with the current seq only to keep the stream monotonic. */
  private foreignFrame(sessions: ForeignSession[]): WsFrame { return { seq: this.getLog().lastSeq(), idx: 0, type: "foreign.sessions", sessions }; }
  broadcast(frames: WsFrame[]) { const data = frames.map((f) => JSON.stringify(f)); for (const ws of this.clients) { if (ws.readyState !== undefined && ws.readyState !== 1) { this.clients.delete(ws); continue; } for (const d of data) { try { ws.send(d); } catch { this.clients.delete(ws); break; } } } }
  handleOpen(ws: Sock, fromSeq: number) {
    const log = this.getLog();
    ws.send(JSON.stringify({ seq: log.lastSeq(), idx: 0, type: "hello", as_of_seq: log.lastFrameSeq(), state: systemState(this.db, this.cfg) } satisfies WsFrame));
    for (const f of log.framesAfter(fromSeq)) ws.send(JSON.stringify(f));
    ws.send(JSON.stringify(this.foreignFrame(this.foreign())));               // nothing replays poll state, so every client is handed the whole current set on connect — including that it is now empty
    this.clients.add(ws);
  }
  /** Broadcast on appear/disappear/state-change only — the watchdog polls every 5s and most ticks are news to nobody. */
  broadcastForeign(sessions: ForeignSession[]) { this.broadcast([this.foreignFrame(sessions)]); }
  handleClose(ws: Sock) { this.clients.delete(ws); }
  get size() { return this.clients.size; }
}
