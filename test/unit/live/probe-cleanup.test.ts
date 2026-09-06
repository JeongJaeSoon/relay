import { expect, test } from "bun:test";
import { cleanupDisposition, cleanupScopedProbes, isScopedProbeAgent, stopAndRemove } from "../../helpers/probe-cleanup.ts";

const sandbox = "/tmp/relay-live-sandbox";
const row = (id: string, state = "working", extra: Record<string, unknown> = {}) => ({ id, sessionId: `session-${id}`, name: `relay-spike:${id}`, cwd: `${sandbox}/.claude/worktrees/${id}`, state, ...extra });
function fake(initial: any[], afterStop: (id: string) => any[] = () => []) {
  let roster = initial; const calls: string[] = [];
  return { calls, deps: { list: async () => roster, stop: async (id: string) => { calls.push(`stop:${id}`); roster = afterStop(id); }, rm: async (id: string) => { calls.push(`rm:${id}`); } } };
}

test("scoping requires both the probe name and sandbox cwd", () => {
  expect(isScopedProbeAgent(row("owned"), sandbox)).toBe(true);
  expect(isScopedProbeAgent({ ...row("foreign"), cwd: "/tmp/elsewhere" }, sandbox)).toBe(false);
  expect(isScopedProbeAgent({ ...row("foreign"), name: "other" }, sandbox)).toBe(false);
});

test("cleanup disposition reuses roster liveness semantics but treats unknown rows as blocking", () => {
  expect(cleanupDisposition(undefined)).toBe("gone");
  expect(cleanupDisposition(row("done", "done"))).toBe("stopped");
  expect(cleanupDisposition(row("pid", "done", { pid: 123 }))).toBe("unknown");
  expect(cleanupDisposition(row("busy", "done", { status: "busy" }))).toBe("unknown");
  expect(cleanupDisposition(row("active", "working"))).toBe("active");
  expect(cleanupDisposition({ id: "unknown" })).toBe("unknown");
});

test("stop then rm accepts a known stopped roster row and accepts a disappeared row", async () => {
  const stopped = fake([row("a")], () => [row("a", "done")]); await stopAndRemove(stopped.deps, sandbox, "a");
  expect(stopped.calls).toEqual(["stop:a", "rm:a"]);
  const gone = fake([row("b")]); await stopAndRemove(gone.deps, sandbox, "b");
  expect(gone.calls).toEqual(["stop:b"]);
});

test("active, unknown, unavailable, and malformed post-stop rosters block removal", async () => {
  const active = fake([row("a")], () => [row("a", "working")]);
  await expect(stopAndRemove(active.deps, sandbox, "a")).rejects.toThrow("Session still"); expect(active.calls).toEqual(["stop:a"]);
  const malformedRow = fake([row("a")], () => [{ id: "a"}]);
  await expect(stopAndRemove(malformedRow.deps, sandbox, "a")).rejects.toThrow("identity changed"); expect(malformedRow.calls).toEqual(["stop:a"]);
  const unavailable = fake([row("a")]); let reads = 0; unavailable.deps.list = async () => { if (++reads === 1) return [row("a")]; throw new Error("roster unavailable"); };
  await expect(stopAndRemove(unavailable.deps, sandbox, "a")).rejects.toThrow("roster unavailable");
  const malformed = fake([row("a")]); malformed.deps.list = async () => ({ nope: true } as any);
  await expect(stopAndRemove(malformed.deps, sandbox, "a")).rejects.toThrow();
});

test("a reused short ID or changed scope after stop blocks removal", async () => {
  const replaced = fake([row("a")], () => [row("a", "done", { sessionId: "different-session" })]);
  await expect(stopAndRemove(replaced.deps, sandbox, "a")).rejects.toThrow("identity changed after stop");
  expect(replaced.calls).toEqual(["stop:a"]);
  const foreign = fake([row("b")], () => [{ ...row("b", "done"), cwd: "/tmp/elsewhere" }]);
  await expect(stopAndRemove(foreign.deps, sandbox, "b")).rejects.toThrow("identity changed after stop");
  expect(foreign.calls).toEqual(["stop:b"]);
});

test("a scoped row without a session identity is never stopped or removed", async () => {
  const missingIdentity = fake([{ ...row("a"), sessionId: undefined }]);
  await expect(stopAndRemove(missingIdentity.deps, sandbox, "a")).rejects.toThrow("Refusing cleanup");
  expect(missingIdentity.calls).toEqual([]);
});

test("an initially scoped row that vanishes before its cleanup turn is already gone", async () => {
  let reads = 0; const calls: string[] = [];
  const deps = { list: async () => ++reads === 1 ? [row("gone")] : [], stop: async (id: string) => { calls.push(`stop:${id}`); }, rm: async (id: string) => { calls.push(`rm:${id}`); } };
  await cleanupScopedProbes(deps, sandbox);
  expect(calls).toEqual([]);
});

test("cleanup attempts every scoped session and reports stop or rm failures", async () => {
  let roster = [row("stop-fails"), row("rm-fails"), row("foreign", "working", { cwd: "/tmp/other" })]; const calls: string[] = [];
  const deps = { list: async () => roster, stop: async (id: string) => { calls.push(`stop:${id}`); if (id === "stop-fails") throw new Error("stop failed"); roster = roster.map((item) => item.id === id ? { ...item, state: "done" } : item); }, rm: async (id: string) => { calls.push(`rm:${id}`); throw new Error("rm refused"); } };
  await expect(cleanupScopedProbes(deps, sandbox)).rejects.toThrow("Probe cleanup incomplete (2 sessions)");
  expect(calls).toEqual(["stop:stop-fails", "stop:rm-fails", "rm:rm-fails"]);
});
