import { expect, test } from "bun:test";
import { join } from "node:path";
const helper = join(import.meta.dir, "../support/smoke-evidence.py");
async function evidence(mode: string, value: unknown, args: string[] = []) {
  const child = Bun.spawn(["python3", helper, mode, ...args], { stdin: new Response(JSON.stringify(value)), stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, output: (await new Response(child.stdout).text()).trim() };
}
test("installed smoke identifies its accepted request, never the first concurrently created task", async () => {
  const tasks = [{ uuid: "foreign", parent_uuid: null }, { uuid: "mine", parent_uuid: null }];
  const snapshot = { tasks, messages: [{ id: "receipt", dispatch_state: "dispatched", task_uuid: "mine" }] };
  expect(await evidence("task", snapshot, ["receipt", "older"])).toEqual({ code: 0, output: "mine" });
  expect((await evidence("task", snapshot, ["receipt", "mine"])).code).toBe(1);
  expect(await evidence("task", { ...snapshot, messages: [] }, ["receipt", "older"])).toEqual({ code: 0, output: "" });
});
test("installed smoke does not claim complete evidence for missing or multiple generations", async () => {
  expect(await evidence("session", { task: { session_id: "s1", process_generation: 1 } })).toEqual({ code: 0, output: "s1" });
  for (const task of [{ process_generation: 1 }, { session_id: "s1", process_generation: 2 }]) expect((await evidence("session", { task })).code).toBe(1);
});
test("cleanup observations follow stable session identity despite name changes", async () => {
  expect(await evidence("remaining", [{ id: "a", sessionId: "s1", name: "renamed" }, { id: "b", sessionId: "s2", name: "relay:T-01 duplicate" }], ["s1"])).toEqual({ code: 0, output: "a" });
  expect(await evidence("remaining", [], ["s1"])).toEqual({ code: 0, output: "" });
  expect((await evidence("remaining", [{ id: "unknown" }], ["s1"])).code).toBe(1);
});
test("installed smoke refuses to run without explicit live opt-in", async () => {
  const child = Bun.spawn(["bash", join(import.meta.dir, "../live/smoke-installed.sh"), "synthetic"], { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(2);
  expect(await new Response(child.stderr).text()).toContain("Explicit opt-in");
});
