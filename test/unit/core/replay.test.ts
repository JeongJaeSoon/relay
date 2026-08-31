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

test("a rebuild lands where migration 2's backfill did: pre-`ask` events are upcast, new ones are believed", async () => {
  const s = await buildTestApp();
  const msg = (id: string, text: string, extra: Record<string, unknown>) => s.log.emit({ type: "message.received", payload: { id, role: "user", source: "user", client_message_id: id, dispatch_state: "dispatched", text, task_uuid: null, reply_to_task_uuid: null, dispatch_json: null, dispatch_error: null, chain_prev_id: null, created_at: 1, ...extra } });
  msg("legacy", "? how are things", {});                                          // v0.1.2 payload: no `ask`, the marker on the text
  msg("work", "? please fix the parser", { source: "github", ask: false });       // post-fix: a ? body that was never a question
  const askOf = (id: string) => (s.db.query("select ask from messages where id=?").get(id) as any).ask;
  expect([askOf("legacy"), askOf("work")]).toEqual([1, 0]);
  rebuildProjections(s.db, s.ctx.cfg);                                            // `relay db rebuild` — must not undo the backfill
  expect([askOf("legacy"), askOf("work")]).toEqual([1, 0]);
});
