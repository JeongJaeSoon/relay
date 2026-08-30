// The core server reads capabilities.json at startup (runner/capabilities.ts), so a malformed or
// half-written spike result must fail here rather than at spawn time.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import caps from "../../spikes/results/capabilities.json";
import { gateVersion, loadCapabilities, parseVersion, versionDrift, versionOk } from "../../src/runner/capabilities.ts";

test("capabilities.json carries the gate results plan 02 depends on", () => {
  expect(caps.cli_version).toMatch(/^2\.1\.(2[5-9]\d|[3-9]\d\d)/);          // >= 2.1.251
  expect(caps.delivery).toBe("socket");
  expect(caps.bgResume).toBe("context-kept");
  expect(caps.flags["--bg"]).toBe(true);
  expect(caps.flags["--json-schema"]).toBe(true);
  expect(caps.advisorFlag).toBe(false);                                     // measured absent: spawnArgs must not emit it
  expect(caps.hookEventsCaptured.length).toBeGreaterThan(0);
});

// Nothing read cli_version before the drift check, so a capabilities.json written by hand or by an older probe can
// be missing it entirely. serve.ts reads it on the boot path, where a throw means launchd writes the service-failed
// flag and the service stays down until the user deletes it — so every version helper has to survive the gap.
test("a capabilities.json without cli_version loads, and no version helper throws on it", () => {
  const f = join(mkdtempSync(join(tmpdir(), "relay-caps-")), "capabilities.json");
  writeFileSync(f, JSON.stringify({ delivery: "socket", bgResume: "context-kept" }));
  const c = loadCapabilities(f);
  expect(c.delivery).toBe("socket");
  expect(c.bgResume).toBe("context-kept");
  expect(c.cli_version).toBe("unknown");
  expect(gateVersion(c)).toBe("unknown");
  expect(versionDrift(c.cli_version, "2.1.251")).toBe("unknown");           // silent: nothing claims to have been measured
  expect(versionOk(c.cli_version)).toBe(false);
  for (const bad of [undefined, null, 42, {}, ["2.1.251"]]) expect(parseVersion(bad)).toEqual([]);
});

test("probe_cli_version is the gate's own stamp, and falls back to the file's when nothing has re-probed", () => {
  const d = mkdtempSync(join(tmpdir(), "relay-caps-"));
  const spikeOnly = join(d, "a.json"); writeFileSync(spikeOnly, JSON.stringify({ delivery: "socket", cli_version: "2.1.251" }));
  expect(gateVersion(loadCapabilities(spikeOnly))).toBe("2.1.251");
  const probed = join(d, "b.json"); writeFileSync(probed, JSON.stringify({ delivery: "socket", cli_version: "2.1.251", probe_cli_version: "2.1.300 (Claude Code)" }));
  expect(gateVersion(loadCapabilities(probed))).toBe("2.1.300 (Claude Code)");
});
