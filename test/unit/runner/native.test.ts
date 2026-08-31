import { expect, test } from "bun:test";
import { normalizeAgentRow, parseBg, parseRm, spawnArgs } from "../../../src/runner/native.ts";
import fixture from "../../fixtures/agents-json.json";

test("parseBg", () => expect(parseBg("warning: x\nbackgrounded · 94dfd830 · relay:T-01 spike\n  claude agents")).toEqual({ short: "94dfd830", name: "relay:T-01 spike" }));
test("normalizeAgentRow accepts both documented and observed vocab", () => {
  expect(normalizeAgentRow({ id: "a", sessionId: "s", name: "n", cwd: "/c", kind: "background", state: "working", status: "busy", pid: 1 })).toMatchObject({ short_id: "a", alive: true, busy: true });
  expect(normalizeAgentRow({ id: "a", sessionId: "s", state: "blocked", status: "waiting", waitingFor: "input needed", pid: 2 })).toMatchObject({ alive: true, busy: false, waiting_for: "input needed" });
  expect(normalizeAgentRow({ id: "a", sessionId: "s", state: "stopped" })).toMatchObject({ alive: false, pid: null });
  for (const raw of fixture as any[]) expect(() => normalizeAgentRow(raw)).not.toThrow();
});
test("a background row without a pid is still alive (agents --json omits pid for --bg sessions)", () => {
  const bg = (fixture as any[]).find((r) => r.kind === "background" && r.state === "blocked");
  expect(normalizeAgentRow(bg)).toMatchObject({ alive: true, pid: null });
  expect(normalizeAgentRow((fixture as any[]).find((r) => r.state === "done"))).toMatchObject({ alive: false });
  expect(normalizeAgentRow((fixture as any[]).find((r) => r.kind === "interactive"))).toMatchObject({ alive: true, busy: true });
});
test("spawnArgs matches the canonical command and never passes --advisor (CLI 2.1.251 has no such flag)", () => {
  const a = spawnArgs({ taskUuid: "u", displayId: "T-08", name: "relay:T-08 auth", cwd: "/p", worktree: "relay-abcd1234", model: "claude-opus-5", effort: "xhigh", permissionMode: "auto", advisor: "claude-fable-5", agent: "relay-worker", settingsJson: "{}", prompt: "hi", env: {} });
  expect(a).toEqual(["--bg", "-w", "relay-abcd1234", "-n", "relay:T-08 auth", "--agent", "relay-worker", "--model", "claude-opus-5", "--effort", "xhigh", "--permission-mode", "auto", "--settings", "{}", "hi"]);
  expect(spawnArgs({ taskUuid: "u", displayId: "T-08", name: "n", cwd: "/p", worktree: null, model: "m", effort: "high", permissionMode: "auto", advisor: null, agent: "relay-worker", settingsJson: "{}", prompt: "hi", env: {} })).not.toContain("-w");
});

// Verbatim `claude rm` output, CLI 2.1.251, re-measured 2026-08-31 against a worktree with a real origin. The three
// refusals need three different moves from the user, so relay must report the CLI's own words, not a guess: telling
// someone their tree is dirty when it is clean and merely unpushed sends them looking for a file that is not there.
test("parseRm keeps the three refusals apart and carries the path the user has to look at", () => {
  const unpushed = "kept 07fe3848 — worktree has commits that are not pushed anywhere\n  worktree kept at /p/.claude/worktrees/relay-abc\n  resolve that (commit/push, or remove the worktree), then run 'claude rm 07fe3848' again\n";
  expect(parseRm(unpushed)).toEqual({ worktreeKept: true, reason: "worktree has commits that are not pushed anywhere", keptPath: "/p/.claude/worktrees/relay-abc" });
  const dirty = "kept 99816309 — worktree has uncommitted changes\n  worktree kept at /p/.claude/worktrees/relay-def\n";
  expect(parseRm(dirty).reason).toBe("worktree has uncommitted changes");
  const locked = "kept 99816309 — worktree is locked — in use by another live session, or locked by hand\n  worktree kept at /p/wt\n";
  expect(parseRm(locked).reason).toBe("worktree is locked — in use by another live session, or locked by hand");
  expect(parseRm("removed 6063a069\n")).toEqual({ worktreeKept: false });
});
