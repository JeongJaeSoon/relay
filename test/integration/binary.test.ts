import { expect, test } from "bun:test";
import { binaryServerEnv, runBinarySmoke, stopChild } from "../../scripts/test-binary.ts";

test("binary server environment excludes ambient service flags and credentials", () => {
  const env = binaryServerEnv("/tmp/relay-smoke", { PATH: "/bin", RELAY_SERVICE: "1", ANTHROPIC_API_KEY: "secret", BUN_CONFIG_VERBOSE_FETCH: "1" });
  expect(env).toEqual({ HOME: "/tmp/relay-smoke", PATH: "/bin", TMPDIR: "/tmp/relay-smoke", RELAY_HOME: "/tmp/relay-smoke", RELAY_LOG_DIR: "/tmp/relay-smoke", RELAY_NO_FILE_LOG: "1" });
});

test("binary child shutdown escalates when SIGTERM is ignored", async () => {
  const child = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(50);
  const started = Date.now(); const exitCode = await stopChild(child, 50);
  expect(exitCode).not.toBe(0); expect(Date.now() - started).toBeLessThan(1_000);
});

test("compiled binary serves the built dashboard and enforces the hook guard", async () => {
  const result = await runBinarySmoke({ PATH: process.env.PATH, RELAY_SERVICE: "1", ANTHROPIC_API_KEY: "secret", BUN_CONFIG_VERBOSE_FETCH: "1" });
  expect(result.version).toMatch(/^relay \d+\.\d+\.\d+$/);
  expect(result.dashboardBytes).toBeGreaterThan(1_000);
  expect(result.guardExitCode).toBe(2);
}, 30_000);
