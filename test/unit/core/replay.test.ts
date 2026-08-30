import { expect, test } from "bun:test";
import { buildTestApp } from "../../helpers/app.ts";
import { rebuildProjections } from "../../../src/core/replay.ts";
test("rebuildProjections reproduces every projection table from the event log alone", async () => {
  const s = await buildTestApp(); const a = s.seedTask("running"); s.seedTask("queued", { session_id: null, short_id: null, process_state: "none", queued_at: 1 });
  s.svc.interrupt(a); await s.settle(); s.svc.pause(); await s.settle();
  const tables = ["tasks", "messages", "commands", "permit_leases", "ws_frames", "meta"];
  const snap = () => tables.map((t) => JSON.stringify(s.db.query(`select * from ${t} order by 1`).all()));
  const before = snap(); s.db.run("update tasks set title='corrupt'"); s.db.run("delete from ws_frames");   // simulate a damaged cache
  expect(rebuildProjections(s.db, s.ctx.cfg)).toBe((s.db.query("select count(*) c from events").get() as any).c);
  expect(snap()).toEqual(before);
});
