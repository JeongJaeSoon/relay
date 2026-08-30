import { expect, test } from "bun:test";
import { buildTestApp } from "../../helpers/app.ts";
import { IdleReaper } from "../../../src/lifecycle/idle.ts";
import { setNow } from "../../../src/core/clock.ts";
import { loadTask } from "../../../src/core/events.ts";
test("idle reaper stops idle-but-alive tasks after 15 min (once) and closes done tasks after 72h; running tasks are untouched", async () => {
  const s = await buildTestApp(); const t0 = Date.now(); setNow(() => t0);
  const done = s.seedTask("done", { updated_at: t0 }); const run = s.seedTask("running", { updated_at: t0 });
  const reaper = new IdleReaper(s.db, s.log, s.ctx.cfg, s.outbox, s.svc);
  try {
    setNow(() => t0 + 16 * 60_000); reaper.tick(); reaper.tick(); await s.settle();
    expect(s.db.query("select count(*) c from commands where kind='stop' and task_uuid=?").get(done)).toEqual({ c: 1 });   // not duplicated by the second tick
    expect(s.db.query("select count(*) c from commands where task_uuid=?").get(run)).toEqual({ c: 0 });
    expect(s.db.query("select count(*) c from events where type='idle.deadline'").get()).toEqual({ c: 1 });
    setNow(() => t0 + 73 * 3600_000); reaper.tick(); await s.settle();
    expect(loadTask(s.db, done)!.status).toBe("closed"); expect(loadTask(s.db, run)!.status).toBe("running");
  } finally { setNow(null); }
});
