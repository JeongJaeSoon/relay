import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTestApp } from "../../helpers/app.ts";
import { UsageGuard } from "../../../src/lifecycle/usage.ts";
import { parseConfig } from "../../../src/config.ts";
import { setNow } from "../../../src/core/clock.ts";
import { loadTask } from "../../../src/core/events.ts";
const line = (i: number, o: number, cr = 0) => JSON.stringify({ type: "assistant", message: { usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: cr } } }) + "\n";
test("sampleTranscript sums assistant usage incrementally", async () => {
  const s = await buildTestApp(); const t = s.seedTask("running"); const task = loadTask(s.db, t)!;
  const f = join(mkdtempSync(join(tmpdir(), "relay-usage-")), "t.jsonl"); writeFileSync(f, line(100, 50, 25) + line(100, 50));
  const g = new UsageGuard(s.db, s.log, s.ctx.cfg, s.svc);
  expect(g.sampleTranscript(task, f)).toBe(325); expect(g.sampleTranscript(task, f)).toBe(0);
  appendFileSync(f, line(10, 5)); expect(g.sampleTranscript(task, f)).toBe(15); expect(loadTask(s.db, t)!.usage_tokens).toBe(340);
});
test("wall-clock cap interrupts, daily ceiling pauses, per-turn tool cap trips", async () => {
  const s = await buildTestApp(); const t0 = Date.now(); setNow(() => t0);
  const cfg = parseConfig("[usage]\ndaily_ceiling_tokens = 100\nmax_tool_calls_per_turn = 2\n");
  const small = s.seedTask("running", { size: "small", started_at: t0 - 21 * 60_000 }); const g = new UsageGuard(s.db, s.log, cfg, s.svc);
  try {
    g.tick(); await s.settle(); expect(loadTask(s.db, small)!.status).toBe("cancelled");
    s.log.emit({ type: "usage.sampled", task_uuid: null, payload: { source: "worker", delta: 150 } }); g.tick(); expect(s.svc.paused()).toBe(true);
    expect(g.countToolCall("x", "p1")).toBe(false); expect(g.countToolCall("x", "p1")).toBe(false); expect(g.countToolCall("x", "p1")).toBe(true); expect(g.countToolCall("x", "p2")).toBe(false);
  } finally { setNow(null); }
});
test("transcript offsets persist in meta (restart-safe) and reset when the file shrinks; a stuck subagent lease is reclaimed by wall-clock", async () => {
  const s = await buildTestApp(); const t = s.seedTask("running"); const task = loadTask(s.db, t)!;
  const f = join(mkdtempSync(join(tmpdir(), "relay-usage-")), "t.jsonl"); writeFileSync(f, line(100, 50));
  expect(new UsageGuard(s.db, s.log, s.ctx.cfg, s.svc).sampleTranscript(task, f)).toBe(150);
  expect(new UsageGuard(s.db, s.log, s.ctx.cfg, s.svc).sampleTranscript(task, f)).toBe(0);      // a fresh instance reads the offset from meta
  writeFileSync(f, line(1, 1)); expect(new UsageGuard(s.db, s.log, s.ctx.cfg, s.svc).sampleTranscript(task, f)).toBe(2);   // shrunk → from 0
  const t0 = Date.now(); setNow(() => t0);
  try {
    s.permits.acquire({ holder_kind: "subagent", holder_id: "agent:zz", task_uuid: t }); expect(s.permits.active()).toBe(1);
    setNow(() => t0 + 9 * 3600_000); new UsageGuard(s.db, s.log, s.ctx.cfg, s.svc, s.permits).tick(); expect(s.permits.active()).toBe(0);
  } finally { setNow(null); }
});
