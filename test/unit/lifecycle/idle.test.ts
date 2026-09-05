import { expect, test } from "bun:test";
import { buildTestApp } from "../../helpers/app.ts";
import { IdleReaper } from "../../../src/lifecycle/idle.ts";
import { setNow } from "../../../src/core/clock.ts";
import { loadTask } from "../../../src/core/events.ts";
test("idle reaper stops idle-but-alive tasks after 15 min (once) and closes done tasks after 72h; running tasks are untouched", async () => {
  const s = await buildTestApp(); const t0 = Date.now(); setNow(() => t0);
  const done = s.seedTask("done", { updated_at: t0 }); const run = s.seedTask("running", { updated_at: t0 });
  const err = s.seedTask("error", { updated_at: t0 }); const ask = s.seedTask("waiting_input", { updated_at: t0 });
  const reaper = new IdleReaper(s.db, s.log, s.ctx.cfg, s.outbox, s.svc);
  try {
    setNow(() => t0 + 16 * 60_000); reaper.tick(); reaper.tick(); await s.settle();
    expect(s.db.query("select count(*) c from commands where kind='stop' and task_uuid=?").get(done)).toEqual({ c: 1 });   // not duplicated by the second tick
    expect(s.db.query("select count(*) c from commands where task_uuid=?").get(run)).toEqual({ c: 0 });
    expect(s.db.query("select count(*) c from events where type='idle.deadline' and task_uuid=?").get(done)).toEqual({ c: 1 });
    expect(s.db.query("select count(*) c from events where type='idle.deadline' and task_uuid=?").get(run)).toEqual({ c: 0 });
    expect(s.db.query("select count(*) c from commands where kind='stop' and task_uuid=?").get(ask)).toEqual({ c: 1 });   // waiting_input is stopped but never closed
    setNow(() => t0 + 73 * 3600_000); reaper.tick(); await s.settle();
    expect(loadTask(s.db, done)!.status).toBe("closed"); expect(loadTask(s.db, run)!.status).toBe("running");
    // An errored task leaked its session forever, because `close` is the only path that disposes of one and nothing
    // ever called it for an error. It waits on nobody, so the same deadline applies.
    expect(loadTask(s.db, err)!.status).toBe("closed");
    // A question nobody answered is not garbage — closing it would discard the question.
    expect(loadTask(s.db, ask)!.status).toBe("waiting_input");
  } finally { setNow(null); }
});

test("an errored task whose session came back is stopped by the 15-min deadline, not left alive until the 72h one", async () => {
  const s = await buildTestApp(); const t0 = Date.now(); setNow(() => t0);
  // recovery restores a live roster session to process_state=alive but only rewrites the status when it was `starting`,
  // so an errored task can sit here with a live process and never reach the stop sweep.
  const err = s.seedTask("error", { updated_at: t0, process_state: "alive" });
  const reaper = new IdleReaper(s.db, s.log, s.ctx.cfg, s.outbox, s.svc);
  try {
    setNow(() => t0 + 16 * 60_000); reaper.tick(); await s.settle();
    expect(s.db.query("select count(*) c from commands where kind='stop' and task_uuid=?").get(err)).toEqual({ c: 1 });
    expect(s.runner.rows.get("fake01")!.alive).toBe(false);
    expect(loadTask(s.db, err)!.status).toBe("error");                       // retry still resumes from session_id
  } finally { setNow(null); }
});

test("a close the CLI refused is not re-attempted on every tick, and the task stays visible instead of closed", async () => {
  const s = await buildTestApp(); const t0 = Date.now(); setNow(() => t0);
  const done = s.seedTask("done", { updated_at: t0, process_state: "stopped", worktree_path: "/tmp/myapp/.claude/worktrees/relay-abc" });
  s.runner.keepWorktree = { reason: "worktree has commits that are not pushed anywhere", keptPath: "/tmp/myapp/.claude/worktrees/relay-abc" };
  const reaper = new IdleReaper(s.db, s.log, s.ctx.cfg, s.outbox, s.svc);
  try {
    setNow(() => t0 + 73 * 3600_000); reaper.tick(); await s.settle();
    // the refusal moved `updated_at`, so only a sweep past the NEXT deadline can prove the guard rather than the clock
    setNow(() => t0 + 2 * 73 * 3600_000); reaper.tick(); reaper.tick(); await s.settle();
    expect(s.runner.calls.filter((c) => c.kind === "rm").length).toBe(1);   // one attempt; resolving the worktree is a person's job
    expect(loadTask(s.db, done)!.status).toBe("error"); expect(s.runner.rows.size).toBe(1);
  } finally { setNow(null); }
});

test("the reaper re-runs a disposal that was held on a locked worktree — a closing task gets a run() from nowhere else", async () => {
  const s = await buildTestApp(); const t0 = Date.now(); setNow(() => t0);
  const done = s.seedTask("done", { updated_at: t0, process_state: "stopped" });
  s.runner.keepWorktree = { reason: "worktree is locked — in use by another live session, or locked by hand", retryable: true };
  const reaper = new IdleReaper(s.db, s.log, s.ctx.cfg, s.outbox, s.svc);
  try {
    s.svc.close(done); await s.settle();
    expect(s.db.query("select state from commands where kind='rm'").get()).toEqual({ state: "pending" });
    expect(loadTask(s.db, done)!.status).toBe("done"); expect(s.runner.rows.has("fake01")).toBe(true);
    s.runner.keepWorktree = null; reaper.tick(); await s.settle();     // the session finished exiting
    expect(loadTask(s.db, done)!.status).toBe("closed"); expect(s.runner.rows.has("fake01")).toBe(false);
  } finally { setNow(null); }
});

test("the reaper's re-run reaches a held REAP rm too — retryable was added at both rm sites", async () => {
  const s = await buildTestApp(); const t0 = Date.now(); setNow(() => t0);
  const t = s.seedTask("done", { updated_at: t0, process_state: "stopped" });
  // `--bg --resume` forks: the older session id survives only in process_instances, which is what a reap works from
  s.log.emit({ type: "process.started", task_uuid: t, process_generation: 2, payload: { generation: 2, session_id: "sid-old", short_id: "old1" } });
  s.log.emit({ type: "process.started", task_uuid: t, process_generation: 3, payload: { generation: 3, session_id: "sid1", short_id: "fake01" } });
  s.log.emit({ type: "task.patched", task_uuid: t, payload: { patch: { process_state: "stopped" } } });
  s.runner.rows.set("old1", { short_id: "old1", session_id: "sid-old", name: "n", cwd: "/tmp/myapp", pid: 9, alive: true, busy: false, waiting_for: null, raw: {} });
  s.runner.keepWorktree = { reason: "worktree is locked — in use by another live session, or locked by hand", retryable: true };
  const reaper = new IdleReaper(s.db, s.log, s.ctx.cfg, s.outbox, s.svc);
  try {
    for (const row of s.runner.rows.values()) row.alive = false; // The lock outlives process exit.
    s.outbox.reapRms(loadTask(s.db, t)!); await s.settle();
    expect(s.db.query("select state from commands where kind='rm'").get()).toEqual({ state: "pending" });
    expect(s.runner.rows.has("old1")).toBe(true);
    s.runner.keepWorktree = null; reaper.tick(); await s.settle();
    expect(s.db.query("select state from commands where kind='rm'").get()).toEqual({ state: "applied" });
    expect(s.runner.rows.has("old1")).toBe(false);
  } finally { setNow(null); }
});
