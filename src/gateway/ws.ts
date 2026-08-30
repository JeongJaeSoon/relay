import type { Database } from "bun:sqlite";
import type { WsFrame } from "@shared/types.ts";
import type { Config } from "../config.ts";
import type { EventLog } from "../core/events.ts";
import { systemState } from "../core/projections.ts";
type Sock = { send(s: string): void; readyState?: number };
export class WsHub {
  private clients = new Set<Sock>();
  constructor(private getLog: () => EventLog, private cfg: Config, private db: Database) {}
  broadcast(frames: WsFrame[]) { const data = frames.map((f) => JSON.stringify(f)); for (const ws of this.clients) { if (ws.readyState !== undefined && ws.readyState !== 1) { this.clients.delete(ws); continue; } for (const d of data) { try { ws.send(d); } catch { this.clients.delete(ws); break; } } } }
  handleOpen(ws: Sock, fromSeq: number) {
    const log = this.getLog();
    ws.send(JSON.stringify({ seq: log.lastSeq(), idx: 0, type: "hello", as_of_seq: log.lastSeq(), state: systemState(this.db, this.cfg) } satisfies WsFrame));
    for (const f of log.framesAfter(fromSeq)) ws.send(JSON.stringify(f));
    this.clients.add(ws);
  }
  handleClose(ws: Sock) { this.clients.delete(ws); }
  get size() { return this.clients.size; }
}
