// relay's whole read of the CLI (stdout shapes, agents --json vocabulary, hook payloads, the inbox frame format)
// is measured once and cached in capabilities.json. These tests pin the rule that decides when that cache is
// old enough to be worth telling the user about.
import { expect, test } from "bun:test";
import { driftWarns, versionDrift } from "../../../src/runner/capabilities.ts";

test("an identical version is not drift", () => {
  expect(versionDrift("2.1.251", "2.1.251")).toBe("same");
  expect(versionDrift("2.1.251 (Claude Code)", "2.1.251")).toBe("same");        // `claude --version` prints a suffix
  expect(driftWarns("same")).toBe(false);
});

test("a patch bump is reported but stays quiet", () => {
  expect(versionDrift("2.1.251", "2.1.260")).toBe("patch");
  expect(versionDrift("2.1.260", "2.1.251")).toBe("patch");                     // a downgrade is the same distance
  expect(driftWarns("patch")).toBe(false);
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
