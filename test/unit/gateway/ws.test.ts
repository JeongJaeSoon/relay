import { describe, expect, test } from "bun:test";
import { WsHub } from "../../../src/gateway/ws.ts";
import { openDb, migrate } from "../../../src/db/db.ts";
import { EventLog } from "../../../src/core/events.ts";
import { parseConfig } from "../../../src/config.ts";
import { snapshot } from "../../../src/gateway/snapshot.ts";

function fakeWs() { const sent: any[] = []; return { sent, send: (s: string) => sent.push(JSON.parse(s)), readyState: 1 } as any; }

describe("WsHub", () => {
  test("hello + replay from from_seq, then live", () => {
    const db = openDb(":memory:"); migrate(db); const cfg = parseConfig("");
    const hub = new WsHub(() => log, cfg, db); const log = new EventLog(db, (f) => hub.broadcast(f), cfg);
    db.run("insert into projects(id,name,path,created_at) values('p','p','/p',1)");
    log.emit({ type: "project.registered", payload: { id: "p2", name: "q", path: "/q", description: "", keywords: [], base_ref: "fresh", is_git: true, created_at: 1 } });
    log.emit({ type: "project.removed", payload: { id: "p2" } });
    const ws = fakeWs(); hub.handleOpen(ws, 1);
    expect(ws.sent[0].type).toBe("hello"); expect(ws.sent[0].as_of_seq).toBe(2);
    expect(ws.sent.slice(1).map((f: any) => f.seq)).toEqual([2]);          // only seq > 1 replayed
    log.emit({ type: "project.registered", payload: { id: "p3", name: "r", path: "/r", description: "", keywords: [], base_ref: "fresh", is_git: true, created_at: 1 } });
    expect(ws.sent.at(-1).seq).toBe(3);
    hub.handleClose(ws);
  });
});

test("hello promises the frame cursor, not the event cursor", () => {
  // A client's cursor only advances on frames it applies, so an event that produces none (system.recovered, emitted on
  // every start) must not raise as_of_seq — otherwise the reconnect banner never clears.
  const db = openDb(":memory:"); migrate(db); const cfg = parseConfig("");
  const hub = new WsHub(() => log, cfg, db); const log = new EventLog(db, (f) => hub.broadcast(f), cfg);
  log.emit({ type: "project.registered", payload: { id: "p1", name: "q", path: "/q", description: "", keywords: [], base_ref: "fresh", is_git: true, created_at: 1 } });
  log.emit({ type: "system.recovered", payload: { reconciled: 0 } });
  expect(log.lastSeq()).toBe(2);
  expect(log.lastFrameSeq()).toBe(1);
  const ws = fakeWs(); hub.handleOpen(ws, 0);
  expect(ws.sent[0].as_of_seq).toBe(1);
  expect(ws.sent.slice(1).map((f: any) => f.seq)).toEqual([1]);            // the replay reaches the promise exactly
});

test("a ws_frames row left empty by an older build does not raise the promise either", () => {
  const db = openDb(":memory:"); migrate(db); const cfg = parseConfig("");
  const hub = new WsHub(() => log, cfg, db); const log = new EventLog(db, (f) => hub.broadcast(f), cfg);
  log.emit({ type: "project.registered", payload: { id: "p1", name: "q", path: "/q", description: "", keywords: [], base_ref: "fresh", is_git: true, created_at: 1 } });
  log.emit({ type: "system.recovered", payload: { reconciled: 0 } });
  db.run("insert or replace into ws_frames(seq,frame_json) values(2,'[]')");   // what every database written before this change looks like
  expect(log.lastFrameSeq()).toBe(1);
  expect(snapshot(db, cfg).as_of_seq).toBe(1);                              // the snapshot promises the same seq as hello
});
