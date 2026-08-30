// relay's whole read of the CLI (stdout shapes, agents --json vocabulary, hook payloads, the inbox frame format)
// is measured once and cached in capabilities.json. These tests pin the rule that decides when that cache is
// old enough to be worth telling the user about.
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { currentCliVersion, driftWarns, versionDrift, versionOk } from "../../../src/runner/capabilities.ts";

test("an identical version is not drift", () => {
  expect(versionDrift("2.1.251", "2.1.251")).toBe("same");
  expect(versionDrift("2.1.251 (Claude Code)", "2.1.251")).toBe("same");        // `claude --version` prints a suffix
  expect(driftWarns("same")).toBe(false);
});

// Claude Code's release stream lives in the patch field — the floor is 2.1.251 and `claude update` moves to 2.1.3xx —
// so a patch bump is the common case, not a negligible one, and it does move measured surfaces (roadmap C7).
test("a patch bump warns", () => {
  expect(versionDrift("2.1.251", "2.1.260")).toBe("patch");
  expect(versionDrift("2.1.260", "2.1.251")).toBe("patch");                     // a downgrade is the same distance
  expect(driftWarns("patch")).toBe(true);
});

test("a minor bump warns", () => {
  expect(versionDrift("2.1.251", "2.2.0")).toBe("minor");
  expect(versionDrift("2.2.0", "2.1.251")).toBe("minor");                       // downgrades leave the measurements just as wrong
  expect(driftWarns("minor")).toBe(true);
});

test("a major bump warns", () => {
  expect(versionDrift("2.1.251", "3.0.0")).toBe("major");
  expect(versionDrift("3.0.0", "2.9.9")).toBe("major");
  expect(driftWarns("major")).toBe(true);
});

test("a version that does not parse on either side is unknown, and never warns", () => {
  for (const [a, b] of [["unknown", "2.1.251"], ["2.1.251", ""], ["", ""], ["2.1", "2.1.251"], ["2.1.251", "not a version"]])
    expect(versionDrift(a!, b!)).toBe("unknown");                               // "unknown" is the never-probed default in capabilities.ts
  expect(driftWarns("unknown")).toBe(false);
});

// The boot-time floor warning is `!versionOk(await currentCliVersion(claude_bin))`. versionOk is covered in
// setup.test.ts; this covers the other half without spawning a session — `--version` is a print, not a run.
test("currentCliVersion reads the version line, and yields \"\" when the binary is not there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-ver-"));
  const bin = join(dir, "fake-claude"); writeFileSync(bin, "#!/bin/sh\necho '2.1.240 (Claude Code)'\n"); chmodSync(bin, 0o755);
  const v = await currentCliVersion(bin);
  expect(v).toBe("2.1.240 (Claude Code)");
  expect(versionOk(v)).toBe(false);                                             // below the 2.1.251 floor → boot warns
  expect(versionDrift("2.1.251", v)).toBe("patch");                             // ...and drifts too, but the two answer different questions
  expect(versionDrift("unknown", v)).toBe("unknown");                           // a never-measured file leaves only the floor warning
  expect(await currentCliVersion(join(dir, "no-such-binary"))).toBe("");
});
