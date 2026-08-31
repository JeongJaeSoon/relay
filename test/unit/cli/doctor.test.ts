import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { checkPerms, cliDriftCheck, DRIFT_FIX, DRIFT_FIX_PROBED, mergeProbeResult, parseDaemonStatus, summarize } from "../../../src/cli/doctor.ts";
test("runChecks is a library (no exit) — importable without side effects", async () => { const m = await import("../../../src/cli/doctor.ts"); expect(typeof m.runChecks).toBe("function"); expect(typeof m.probeCapabilities).toBe("function"); });
test("perm check", () => { const d = mkdtempSync(join(tmpdir(), "relay-doc-")); const f = join(d, "t"); writeFileSync(f, "x"); chmodSync(f, 0o644); expect(checkPerms(f, 0o600).ok).toBe(false); chmodSync(f, 0o600); expect(checkPerms(f, 0o600).ok).toBe(true); });
test("daemon status parse", () => expect(parseDaemonStatus("pid:     6499\nversion: 2.1.251\nuptime:  27386s")).toEqual({ pid: 6499, version: "2.1.251" }));
test("summary lists failures with fixes", () => { const s = summarize([{ name: "a", ok: true, detail: "" }, { name: "b", ok: false, detail: "bad", fix: "run x" }]); expect(s).toContain("✔ a"); expect(s).toContain("✖ b"); expect(s).toContain("run x"); });

// The drift check is pure so it can be exercised without a `claude` binary — runChecks() feeds it the version it
// already read for the "claude CLI" check.
test("a matching CLI passes and still names both versions", () => {
  const c = cliDriftCheck("2.1.251", "2.1.251 (Claude Code)");
  expect(c.ok).toBe(true);
  expect(c.detail).toContain("2.1.251"); expect(c.detail).toContain("in sync");
  expect(c.fix).toBe(DRIFT_FIX);
});

// Claude Code releases in the patch field, so the patch case is the one that has to fail — a minor/major cut would
// almost never fire. The level still shows, so the user can weigh a 2.1.251 → 2.1.299 against a 2.1.251 → 3.0.0.
test("any bump fails and points at the probe, with the level in the detail", () => {
  const patch = cliDriftCheck("2.1.251", "2.1.299");
  expect(patch.ok).toBe(false); expect(patch.detail).toContain("patch bump");
  expect(summarize([patch])).toContain("→ relay doctor --probe");
  const minor = cliDriftCheck("2.1.251", "2.4.0");
  expect(minor.ok).toBe(false); expect(minor.detail).toContain("2.1.251"); expect(minor.detail).toContain("2.4.0"); expect(minor.detail).toContain("minor bump");
  const major = cliDriftCheck("2.1.251", "3.0.0");
  expect(major.ok).toBe(false); expect(major.detail).toContain("major bump");
});

// The probe re-measures two of the file's ~70 facts, so it reports the gate and never clears the drift.
test("a re-checked gate is reported but does not clear the drift", () => {
  const c = cliDriftCheck("2.1.251", "2.1.299 (Claude Code)", "2.1.299");
  expect(c.ok).toBe(false);
  expect(c.detail).toContain("probed against 2.1.251 · currently 2.1.299");
  expect(c.detail).toContain("--bg --resume re-checked on 2.1.299");
  expect(c.fix).toBe(DRIFT_FIX_PROBED);                                         // a probe costs a real session — never ask for the one already run
  expect(cliDriftCheck("2.1.251", "2.1.299", "2.1.251").fix).toBe(DRIFT_FIX);
  expect(cliDriftCheck("2.1.251", "2.1.299", "2.1.251").detail).not.toContain("re-checked");   // the gate is as old as the file
  expect(cliDriftCheck("2.1.251", "2.1.251", "2.1.251").detail).not.toContain("re-checked");   // nothing to say when nothing drifted
});

test("an unreadable version on either side never fails the check", () => {
  expect(cliDriftCheck("unknown", "2.1.251").ok).toBe(true);                    // capabilities has its own "missing" check
  expect(cliDriftCheck("2.1.251", "").ok).toBe(true);
  expect(cliDriftCheck("unknown", "").detail).toContain("probed against unknown · currently unknown");
});

// A probe that re-measures the gate must never restamp cli_version: that field says what the *whole* file was
// measured against, and moving it clears the drift warning — including, before this, on a probe that just failed.
test("a probe records its own reach and leaves cli_version alone", () => {
  const before = { cli_version: "2.1.251", delivery: "socket", bgResume: "context-kept", agentsJsonVocab: ["running"], permit: { preToolUseDenyWorks: true } };
  const okRun = mergeProbeResult(before, "2.1.299 (Claude Code)", true, "2026-08-31T00:00:00.000Z");
  expect(okRun.cli_version).toBe("2.1.251");                                    // untouched → the drift check still warns
  expect(okRun.probe_cli_version).toBe("2.1.299 (Claude Code)");
  expect(okRun.probed_at).toBe("2026-08-31T00:00:00.000Z");
  expect(okRun.bgResume).toBe("context-kept"); expect(okRun.delivery).toBe("socket");
  expect(okRun.agentsJsonVocab).toEqual(["running"]);                           // the fields the probe never looked at pass through
  expect(cliDriftCheck(okRun.cli_version, "2.1.299", okRun.probe_cli_version).ok).toBe(false);

  const failed = mergeProbeResult(before, "2.1.299", false);
  expect(failed.cli_version).toBe("2.1.251");
  expect(failed.bgResume).toBe("fail");
  expect(failed.delivery).toBe("socket");                                       // a failed gate is no evidence for a delivery method
  expect(cliDriftCheck(failed.cli_version, "2.1.299", failed.probe_cli_version).ok).toBe(false);
});

test("a probe with no capabilities.json to merge into claims no full measurement", () => {
  const fresh = mergeProbeResult({}, "2.1.299", true);
  expect(fresh.cli_version).toBeUndefined();
  expect(fresh.delivery).toBe("resume");                                        // no print fallback (C9)
  expect(cliDriftCheck(fresh.cli_version ?? "unknown", "2.1.299").ok).toBe(true);   // "unknown" never warns
});

test("keptSessions lists the tasks whose `claude rm` was refused, and drops them once one succeeds", async () => {
  const { keptSessions } = await import("../../../src/cli/doctor.ts");
  const { openDb, migrate } = await import("../../../src/db/db.ts");
  const db = openDb(":memory:"); migrate(db);
  db.run("insert into projects(id,name,path,is_git,created_at) values('p','p','/p',1,1)");
  const task = (uuid: string, display: string, num: number) => db.run("insert into tasks(uuid,num,display_id,project_id,title,status,size,effort,model,process_state,process_generation,turn_state,attach_state,paused,qhead,usage_tokens,worktree_path,created_at,updated_at) values(?,?,?,'p','t','done','normal','xhigh','m','stopped',1,'idle','none',0,0,0,?,1,1)", [uuid, num, display, `/p/.claude/worktrees/${display}`]);
  const rm = (uuid: string, id: string, state: string, target: string | null) => db.run("insert into commands(id,task_uuid,kind,payload_json,state,created_at) values(?,?,'rm',?,?,1)", [id, uuid, JSON.stringify(target ? { kind: "rm", target: { session_id: target, short_id: null } } : { kind: "rm", close: true }), state]);
  task("u1", "T-01", 1); rm("u1", "rm1", "failed", null);                    // refused: the worktree still holds work
  task("u2", "T-02", 2); rm("u2", "rm2", "failed", null); rm("u2", "rm3", "applied", null);   // the user pushed and closed it again
  task("u3", "T-03", 3); rm("u3", "rm4", "failed", "sid-old");              // a reap of a superseded session, not a task's own disposal
  task("u4", "T-04", 4); rm("u4", "rm5", "unknown", null);                 // relay restarted mid-rm: it cannot tell whether the session is gone
  task("u5", "T-05", 5); rm("u5", "rm6", "pending", null);                 // held on a lock that clears itself — not waiting on a person
  expect(keptSessions(db).map((k) => k.display_id)).toEqual(["T-01", "T-04"]);
  expect(keptSessions(db)[0].worktree_path).toBe("/p/.claude/worktrees/T-01");
  db.close();
});

test("unaccountedSessions finds the orphan close cannot reach, and leaves owned and nascent rows alone", async () => {
  const { unaccountedSessions } = await import("../../../src/cli/doctor.ts");
  const { openDb, migrate } = await import("../../../src/db/db.ts");
  const db = openDb(":memory:"); migrate(db);
  db.run("insert into projects(id,name,path,is_git,created_at) values('p','p','/p',1,1)");
  db.run("insert into tasks(uuid,num,display_id,project_id,title,status,size,effort,model,session_id,short_id,process_state,process_generation,turn_state,attach_state,paused,qhead,usage_tokens,created_at,updated_at) values('u1',1,'T-01','p','t','running','normal','xhigh','m','sid-mine','mine','alive',1,'busy','none',0,0,0,1,1)");
  const row = (short: string, session: string, startedAt: number): any => ({ short_id: short, session_id: session, name: "n", cwd: "/p", pid: 1, alive: true, busy: false, waiting_for: null, raw: { startedAt } });
  const t = 1_000_000;
  const rows = [
    row("mine", "sid-mine", t - 60_000),        // a task owns it
    row("orph", "sid-orph", t - 60_000),        // spawn never recorded a short id: no stop, no rm, no commands row — invisible to keptSessions
    row("new", "sid-new", t - 5_000),           // still inside the grace window the foreign list waits out
  ];
  expect(unaccountedSessions(db, rows, t).map((x) => x.short_id)).toEqual(["orph"]);
  // NaN compares false against everything, so a naive `t - Number(x) >= grace` hides the row whose data is worst
  const bad = [row("nostart", "sid-nostart", 0), row("badstart", "sid-badstart", 0)];
  delete (bad[0] as any).raw.startedAt; (bad[1] as any).raw.startedAt = "not-a-number";
  expect(unaccountedSessions(db, bad, t).map((x) => x.short_id)).toEqual(["nostart", "badstart"]);
  // a fork's earlier session ids live only in process_instances, and those are still sessions relay started
  db.run("insert into process_instances(task_uuid,generation,session_id,short_id,started_at) values('u1',0,'sid-orph','orph',1)");
  expect(unaccountedSessions(db, rows, t)).toEqual([]);
  db.close();
});
