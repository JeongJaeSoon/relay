import { expect, test } from "bun:test";
import { openDb, migrate, getMeta } from "../../../src/db/db.ts";
import { EventLog } from "../../../src/core/events.ts";
import { parseConfig } from "../../../src/config.ts";
import { sweep } from "../../../src/lifecycle/retention.ts";
import { setNow } from "../../../src/core/clock.ts";
test("sweep deletes events/blobs/ws_frames of tasks closed > 90 days ago, keeps recent ones, vacuums monthly", () => {
  const db = openDb(":memory:"); migrate(db); const cfg = parseConfig(""); const log = new EventLog(db, () => {}, cfg);
  log.emit({ type: "project.registered", payload: { id: "p", name: "p", path: "/p", description: "", keywords: [], base_ref: "fresh", is_git: false, created_at: 1 } });
  const mk = (uuid: string, closedAt: number) => { db.run("insert into tasks(uuid,num,display_id,project_id,title,status,size,effort,model,closed_at,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,1,1)", [uuid, Number(uuid.slice(1)), uuid, "p", "t", "closed", "normal", "xhigh", "m", closedAt]);
    for (let i = 0; i < 3; i++) log.emit({ type: "hook.PostToolUse", task_uuid: uuid, payload: { i, tool_response: i === 0 ? "x".repeat(300_000) : "" } }); };   // 300 KB > PAYLOAD_CAP → one blob
  const t0 = Date.now(); setNow(() => t0);
  try {
    mk("u1", t0 - 91 * 86400_000); mk("u2", t0 - 10 * 86400_000);
    expect(sweep(db, 90, log)).toEqual({ events: 3, blobs: 1, vacuumed: true });
    expect(db.query("select count(*) c from events where task_uuid='u1'").get()).toEqual({ c: 0 }); expect(db.query("select count(*) c from events where task_uuid='u2'").get()).toEqual({ c: 3 });
    expect(db.query("select count(*) c from events where type='retention.swept'").get()).toEqual({ c: 1 });
    expect(Number(getMeta(db, "last_vacuum"))).toBe(t0); expect(sweep(db).vacuumed).toBe(false);
  } finally { setNow(null); }
});
