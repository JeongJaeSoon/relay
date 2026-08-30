import { expect, test } from "bun:test";
import { buildTestApp } from "../../helpers/app.ts";
import { Watchdog } from "../../../src/lifecycle/watchdog.ts";
import { setNow } from "../../../src/core/clock.ts";
import { loadTask } from "../../../src/core/events.ts";
test("a vanished process becomes crashed/error after the grace period; a listing failure skips the tick; SessionStart gap is filled from the roster", async () => {
  const s = await buildTestApp(); const t0 = Date.now(); setNow(() => t0);
  const gone = s.seedTask("running"); const fresh = s.seedTask("starting", { process_state: "starting", process_generation: 0, session_id: null, updated_at: t0 - 61_000 });
  s.permits.acquire({ holder_kind: "task", holder_id: `task:${gone}`, task_uuid: gone });
  s.runner.rows.delete("fake01"); s.runner.rows.set("fake02", { short_id: "fake02", session_id: "sid02", name: "n", cwd: "/tmp/myapp", pid: 2, alive: true, busy: true, waiting_for: null, raw: {} });
  const w = new Watchdog(s.db, s.log, s.runner, s.svc, s.permits);
  try {
    await w.tick(); expect(loadTask(s.db, gone)!.status).toBe("running");                       // grace period
    expect(loadTask(s.db, fresh)!.status).toBe("running"); expect(loadTask(s.db, fresh)!.process_generation).toBe(1);   // roster-detected start
    setNow(() => t0 + 61_000); const list = s.runner.list.bind(s.runner); s.runner.list = async () => { throw new Error("busy"); }; await w.tick();
    expect(loadTask(s.db, gone)!.status).toBe("running");                                          // unknown roster ≠ dead
    s.runner.list = list; await w.tick();
    expect(loadTask(s.db, gone)!.status).toBe("error"); expect(loadTask(s.db, gone)!.process_state).toBe("crashed"); expect(s.permits.active()).toBe(0);
    expect(s.db.query("select count(*) c from messages where role='error'").get()).toEqual({ c: 1 });
    expect(s.db.query("select count(*) c from process_instances where task_uuid=? and ended_at is null").get(fresh)).toEqual({ c: 1 });
  } finally { setNow(null); }
});
test("a session that forked on --resume is followed by short id, not lost: the task adopts the new session id", async () => {
  const s = await buildTestApp(); const t0 = Date.now(); setNow(() => t0);
  const t = s.seedTask("running");   // session sid1 / short fake01
  s.runner.rows.set("fake01", { short_id: "fake01", session_id: "forked-sid", name: "n", cwd: "/tmp/myapp", pid: 1, alive: true, busy: true, waiting_for: null, raw: {} });
  const w = new Watchdog(s.db, s.log, s.runner, s.svc, s.permits);
  try {
    await w.tick(); await w.tick();
    expect(loadTask(s.db, t)!.status).toBe("running"); expect(loadTask(s.db, t)!.process_state).toBe("alive");
    expect(loadTask(s.db, t)!.session_id).toBe("forked-sid");   // `claude --bg --resume` forks: new session id, same short id (phase 0)
  } finally { setNow(null); }
});
