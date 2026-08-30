import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTestApp } from "../../helpers/app.ts";
import { FOREIGN_GRACE_MS, foreignRows, isForeign, ownership, publishedChanged, reduceForeign, ForeignSessions } from "../../../src/lifecycle/foreign.ts";
import { OWNER_FILE } from "../../../src/lifecycle/outbox.ts";
import { Watchdog } from "../../../src/lifecycle/watchdog.ts";
import { setNow } from "../../../src/core/clock.ts";
import type { AgentRow } from "../../../src/runner/runner.ts";
import type { ForeignSession } from "@shared/types.ts";

const row = (o: Partial<AgentRow>): AgentRow => ({ short_id: null, session_id: null, name: null, cwd: null, pid: null, alive: true, busy: null, waiting_for: null, raw: {}, ...o });
const own = (o: Partial<{ sessionIds: string[]; shortIds: string[]; stamped: (r: AgentRow) => boolean }> = {}) =>
  ({ sessionIds: new Set(o.sessionIds ?? []), shortIds: new Set(o.shortIds ?? []), stamped: o.stamped ?? (() => false) });

test("classification: a name is not identity — two live sessions sharing one are told apart by session id", () => {
  // Phase 0 ⑦ measured two live sessions with the same name; only the session id decides.
  const ours = row({ session_id: "sid-ours", short_id: "ab11", name: "relay:T-01 auth", cwd: "/w" });
  const theirs = row({ session_id: "sid-theirs", short_id: "cd22", name: "relay:T-01 auth", cwd: "/elsewhere" });
  const o = own({ sessionIds: ["sid-ours"] });
  expect(isForeign(ours, o)).toBe(false);
  expect(isForeign(theirs, o)).toBe(true);
  expect(foreignRows([ours, theirs], o).map((r) => r.session_id)).toEqual(["sid-theirs"]);
});

test("classification: short id, owner stamp, liveness and a missing session id all keep a row out", () => {
  expect(isForeign(row({ session_id: "s1", short_id: "ab11" }), own({ shortIds: ["ab11"] }))).toBe(false);            // a fork kept our short id
  expect(isForeign(row({ session_id: "s2", cwd: "/w" }), own({ stamped: (r) => r.cwd === "/w" }))).toBe(false);       // .relay-owner in the directory
  expect(isForeign(row({ session_id: "s3", alive: false }), own())).toBe(false);                                      // dead rows are history
  expect(isForeign(row({ session_id: null, short_id: "zz99" }), own())).toBe(false);                                  // nothing to track it by
  expect(isForeign(row({ session_id: "s4" }), own())).toBe(true);
});

test("ownership() covers task rows, superseded process instances and a stamped directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-owner-"));
  writeFileSync(join(dir, OWNER_FILE), JSON.stringify({ relay_instance_id: "some-other-relay", task_uuid: "t", session_id: null }));
  const s = await buildTestApp();
  const uuid = s.seedTask("running");                                                                                  // session sid1 / short fake01
  s.db.run("insert into process_instances(id,task_uuid,short_id,session_id,generation,started_at) values('pi1',?,'old01','old-sid',0,1)", [uuid]);
  const o = ownership(s.db);
  expect(isForeign(row({ session_id: "sid1" }), o)).toBe(false);
  expect(isForeign(row({ session_id: "forked", short_id: "fake01" }), o)).toBe(false);
  expect(isForeign(row({ session_id: "old-sid" }), o)).toBe(false);                                                    // a session we started, superseded by a fork
  expect(isForeign(row({ session_id: "outside", cwd: dir }), o)).toBe(false);                                          // any relay stamp means "could be ours"
  expect(isForeign(row({ session_id: "outside", cwd: "/no/such/dir" }), o)).toBe(true);
});

test("reducer: first_seen survives, the grace period holds a row back, and leaving the roster drops it", () => {
  const t0 = 1_000_000;
  const r1 = row({ session_id: "s1", short_id: "ab", name: "scratch", cwd: "/tmp/x", busy: true });
  const a = reduceForeign(new Map(), [r1], t0);
  expect(a.next.get("s1")).toMatchObject({ first_seen: t0, last_seen: t0, busy: true });
  expect(a.published).toEqual([]);                                                                                     // relay's own spawn is indistinguishable for the first 30s
  const b = reduceForeign(a.next, [r1], t0 + FOREIGN_GRACE_MS);
  expect(b.published.map((f) => f.session_id)).toEqual(["s1"]);
  expect(b.published[0]!.first_seen).toBe(t0);                                                                         // not restamped
  expect(b.published[0]!.last_seen).toBe(t0 + FOREIGN_GRACE_MS);
  expect(reduceForeign(b.next, [], t0 + FOREIGN_GRACE_MS + 5000).published).toEqual([]);
});

test("reducer: the session registry supplies pid, start time and launch kind", () => {
  const reg = new Map([["s1", { pid: 4242, started_at: 999, kind: "bg" }]]);
  const { published } = reduceForeign(new Map(), [row({ session_id: "s1" })], 1000, reg, 0);
  expect(published[0]).toMatchObject({ pid: 4242, started_at: 999, kind: "bg" });
});

test("publishedChanged is news only: a heartbeat is not a change, busy/appear/disappear are", () => {
  const f = (o: Partial<ForeignSession>): ForeignSession => ({ session_id: "s1", short_id: "ab", name: "n", cwd: "/c", busy: false, pid: 1, started_at: 1, kind: "bg", first_seen: 1, last_seen: 1, ...o });
  expect(publishedChanged([f({})], [f({ last_seen: 99_999 })])).toBe(false);
  expect(publishedChanged([f({})], [f({ busy: true })])).toBe(true);
  expect(publishedChanged([f({})], [])).toBe(true);
  expect(publishedChanged([], [f({})])).toBe(true);
});

test("ForeignSessions publishes on change only, and the watchdog feeds it without emitting a single event", async () => {
  const s = await buildTestApp(); const t0 = Date.now(); setNow(() => t0);
  try {
    const mine = s.seedTask("running");                                                                                // sid1 / fake01, on the roster
    s.permits.acquire({ holder_kind: "task", holder_id: `task:${mine}`, task_uuid: mine });
    const seen: ForeignSession[][] = [];
    const foreign = new ForeignSessions(s.db, s.runner, (l) => seen.push(l));
    const w = new Watchdog(s.db, s.log, s.runner, s.svc, s.permits, foreign);
    s.runner.rows.set("out1", { short_id: "out1", session_id: "outside-1", name: "my own terminal", cwd: "/no/such/dir", pid: 77, alive: true, busy: true, waiting_for: null, raw: {} });
    const events = () => (s.db.query("select count(*) c from events").get() as any).c as number;
    const before = events();
    await w.tick(); expect(foreign.list()).toEqual([]); expect(seen).toEqual([]);                                       // inside the grace window
    setNow(() => t0 + FOREIGN_GRACE_MS);
    await w.tick();
    expect(foreign.list().map((f) => f.session_id)).toEqual(["outside-1"]);                                             // and NOT sid1: that one is a task's
    expect(seen.length).toBe(1);
    await w.tick(); await w.tick();
    expect(seen.length).toBe(1);                                                                                       // last_seen ticks are not broadcast
    s.runner.rows.get("out1")!.busy = false; await w.tick(); expect(seen.length).toBe(2);
    expect(events()).toBe(before);                                                                                     // nothing about a foreign session is ever written to the log
    expect(s.db.query("select count(*) c from tasks").get()).toEqual({ c: 1 });                                         // and nothing lands in `tasks`
    expect(s.invariants()).toEqual([]);
  } finally { setNow(null); }
});

test("stop() only ever reaches a session that is still foreign on a fresh roster", async () => {
  const s = await buildTestApp(); const t0 = Date.now(); setNow(() => t0);
  try {
    s.seedTask("running");                                                                                // sid1 / fake01
    const foreign = new ForeignSessions(s.db, s.runner);
    s.runner.rows.set("out1", { short_id: "out1", session_id: "outside-1", name: "n", cwd: "/no/such/dir", pid: 77, alive: true, busy: true, waiting_for: null, raw: {} });
    setNow(() => t0 + FOREIGN_GRACE_MS); foreign.refresh(await s.runner.list(true));
    expect((await foreign.stop("sid1")).ok).toBe(false);                                                               // a relay worker is refused even by session id
    expect((await foreign.stop("nope")).ok).toBe(false);
    expect(s.runner.calls.filter((c) => c.kind === "stop")).toEqual([]);
    expect((await foreign.stop("outside-1")).ok).toBe(true);
    expect(s.runner.calls.filter((c) => c.kind === "stop")).toEqual([{ kind: "stop", args: "out1" }]);
    expect(foreign.list()).toEqual([]);                                                                                // gone from the dashboard immediately
  } finally { setNow(null); }
});

test("no automatic path can stop a foreign session: kill switch, idle reaper and usage guard only ever touch tasks", async () => {
  const s = await buildTestApp(); const t0 = Date.now(); setNow(() => t0);
  try {
    s.seedTask("running");
    s.runner.rows.set("out1", { short_id: "out1", session_id: "outside-1", name: "n", cwd: "/no/such/dir", pid: 77, alive: true, busy: true, waiting_for: null, raw: {} });
    s.svc.pause(); await s.settle();                                                                                   // kill switch stops every running TASK
    s.svc.resumeAll(); await s.settle();
    const stopped = s.runner.calls.filter((c) => c.kind === "stop").map((c) => c.args);
    expect(stopped).not.toContain("out1");
    expect(s.runner.rows.get("out1")!.alive).toBe(true);
    expect(s.db.query("select count(*) c from commands where task_uuid='outside-1'").get()).toEqual({ c: 0 });
  } finally { setNow(null); }
});

test("a directory relay owns keeps its session out, even when it is the launch cwd of a non-git project", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-wt-")); mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, OWNER_FILE), JSON.stringify({ relay_instance_id: "i", task_uuid: "t", session_id: "s" }));
  const o = { sessionIds: new Set<string>(), shortIds: new Set<string>(), stamped: ownership({ query: () => ({ all: () => [] }) } as any).stamped };
  expect(isForeign(row({ session_id: "x", cwd: dir }), o)).toBe(false);
  expect(isForeign(row({ session_id: "x", cwd: join(dir, "sub") }), o)).toBe(true);                                     // the stamp is per directory, not inherited
});
