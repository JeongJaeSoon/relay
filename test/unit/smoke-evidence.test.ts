import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  expect((await evidence("task", { tasks: [{ uuid: "foreign", parent_uuid: null }], messages: snapshot.messages }, ["receipt", "older"])).code).toBe(1);
});
test("project selection compares a project name as data, never Python source", async () => {
  const snapshot = { projects: [{ name: "sample-project" }] };
  expect(await evidence("project", snapshot, ["sample-project"])).toEqual({ code: 0, output: "1" });
  expect(await evidence("project", snapshot, ["sample-project'); raise RuntimeError('injected"])).toEqual({ code: 0, output: "0" });
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
test("a timed-out installed smoke interrupts only its receipt-proven task and never closes it", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "relay-smoke-fake-"));
  try {
    const home = join(scratch, "home"), bin = join(scratch, "bin"), calls = join(scratch, "calls");
    mkdirSync(home, { recursive: true }); mkdirSync(bin, { recursive: true });
    writeFileSync(join(home, "config.toml"), "port = 18999\n"); writeFileSync(join(home, "api-token"), "synthetic-token\n");
    const script = (name: string, source: string) => { const path = join(bin, name); writeFileSync(path, source); chmodSync(path, 0o755); };
    script("relay", `#!/bin/sh
case "$1 $2" in
  'doctor --json') echo '[]';;
  send*) touch ${JSON.stringify(join(scratch, "sent"))}; echo 'Accepted receipt · synthetic';;
  ls*) :;;
esac
`);
    script("claude", "#!/bin/sh\nprintf '[]'\n");
    script("sleep", "#!/bin/sh\nexit 0\n");
    script("curl", `#!/bin/sh
echo "$*" >> ${JSON.stringify(calls)}
case "$*" in
  *'/usage'*) echo '{"paused":false,"version":"test","delivery_method":"fake"}' ;;
  *'/tasks?include=closed'*) if [ -e ${JSON.stringify(join(scratch, "sent"))} ]; then echo '{"tasks":[{"uuid":"foreign","parent_uuid":null,"status":"running"},{"uuid":"mine","parent_uuid":null,"status":"running","short_id":"m","process_generation":1,"last_step":""}],"projects":[{"name":"sample-project"}],"messages":[{"id":"receipt","dispatch_state":"dispatched","task_uuid":"mine"}]}' ; else echo '{"tasks":[{"uuid":"foreign","parent_uuid":null,"status":"running"}],"projects":[{"name":"sample-project"}],"messages":[]}' ; fi ;;
  *'/tasks/mine/interrupt'*) echo '{"ok":true}' ;;
  *'/tasks/mine'*) echo '{"task":{"uuid":"mine","status":"running","short_id":"m","process_generation":1,"session_id":"s-mine","last_summary":""}}' ;;
  *) echo '{}' ;;
esac
`);
    const child = Bun.spawn(["bash", join(import.meta.dir, "../live/smoke-installed.sh"), "sample-project", "--timeout-min", "0"], { env: { ...process.env, RELAY_LIVE_TESTS: "1", RELAY_HOME: home, SMOKE_OUT: join(scratch, "out"), PATH: `${bin}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(1);
    const requests = readFileSync(calls, "utf8");
    expect(requests.match(/\/tasks\/mine\/interrupt/g)).toHaveLength(1);
    expect(requests).not.toContain("/tasks/foreign/interrupt");
    expect(requests).not.toContain("/tasks/mine/close");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 10_000);
