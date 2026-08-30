// The core server reads capabilities.json at startup (runner/capabilities.ts), so a malformed or
// half-written spike result must fail here rather than at spawn time.
import { expect, test } from "bun:test";
import caps from "../../spikes/results/capabilities.json";

test("capabilities.json carries the gate results plan 02 depends on", () => {
  expect(caps.cli_version).toMatch(/^2\.1\.(2[5-9]\d|[3-9]\d\d)/);          // >= 2.1.251
  expect(caps.delivery).toBe("socket");
  expect(caps.bgResume).toBe("context-kept");
  expect(caps.flags["--bg"]).toBe(true);
  expect(caps.flags["--json-schema"]).toBe(true);
  expect(caps.advisorFlag).toBe(false);                                     // measured absent: spawnArgs must not emit it
  expect(caps.hookEventsCaptured.length).toBeGreaterThan(0);
});
