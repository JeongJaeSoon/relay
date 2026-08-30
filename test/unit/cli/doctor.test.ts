import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { checkPerms, parseDaemonStatus, summarize } from "../../../src/cli/doctor.ts";
test("runChecks is a library (no exit) — importable without side effects", async () => { const m = await import("../../../src/cli/doctor.ts"); expect(typeof m.runChecks).toBe("function"); expect(typeof m.probeCapabilities).toBe("function"); });
test("perm check", () => { const d = mkdtempSync(join(tmpdir(), "relay-doc-")); const f = join(d, "t"); writeFileSync(f, "x"); chmodSync(f, 0o644); expect(checkPerms(f, 0o600).ok).toBe(false); chmodSync(f, 0o600); expect(checkPerms(f, 0o600).ok).toBe(true); });
test("daemon status parse", () => expect(parseDaemonStatus("pid:     6499\nversion: 2.1.251\nuptime:  27386s")).toEqual({ pid: 6499, version: "2.1.251" }));
test("summary lists failures with fixes", () => { const s = summarize([{ name: "a", ok: true, detail: "" }, { name: "b", ok: false, detail: "bad", fix: "run x" }]); expect(s).toContain("✔ a"); expect(s).toContain("✖ b"); expect(s).toContain("run x"); });
