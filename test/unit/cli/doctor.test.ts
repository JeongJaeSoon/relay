import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { checkPerms, cliDriftCheck, parseDaemonStatus, summarize } from "../../../src/cli/doctor.ts";
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
  expect(c.fix).toBe("relay doctor --probe");
});

test("a patch bump passes; a minor or major bump fails and points at the probe", () => {
  expect(cliDriftCheck("2.1.251", "2.1.299").ok).toBe(true);
  const minor = cliDriftCheck("2.1.251", "2.4.0");
  expect(minor.ok).toBe(false); expect(minor.detail).toContain("2.1.251"); expect(minor.detail).toContain("2.4.0");
  expect(summarize([minor])).toContain("→ relay doctor --probe");
  expect(cliDriftCheck("2.1.251", "3.0.0").ok).toBe(false);
});

test("an unreadable version on either side never fails the check", () => {
  expect(cliDriftCheck("unknown", "2.1.251").ok).toBe(true);                    // capabilities has its own "missing" check
  expect(cliDriftCheck("2.1.251", "").ok).toBe(true);
  expect(cliDriftCheck("unknown", "").detail).toContain("probed against unknown · currently unknown");
});
