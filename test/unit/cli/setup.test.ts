import { expect, test } from "bun:test";
import { parseVersion, versionOk, tomlStringify, planAgentInstall, discoverRepos, probeReason } from "../../../src/cli/setup.ts";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../../src/config.ts";
test("version parsing", () => { expect(parseVersion("2.1.251 (Claude Code)")).toEqual([2, 1, 251]); expect(versionOk("2.1.251")).toBe(true); expect(versionOk("2.1.250")).toBe(false); expect(versionOk("2.2.0")).toBe(true); });
test("toml round trip", () => { const c = parseConfig("port = 9001\npath_prepend = [\"/opt/x/bin\"]\n[dispatcher]\nmodel = \"claude-opus-5\"\n"); const back = parseConfig(tomlStringify(c)); expect(back.port).toBe(9001); expect(back.path_prepend).toEqual(["/opt/x/bin"]); expect(back.dispatcher.model).toBe("claude-opus-5"); expect(back.worker.effort.normal).toBe("xhigh"); });
test("agent install plan", () => { expect(planAgentInstall({ "relay-worker.md": "old", "relay-explore.md": "x", "relay-verify.md": null }, { "relay-worker.md": "new", "relay-explore.md": "x", "relay-verify.md": "v" })).toEqual({ copy: ["relay-verify.md"], same: ["relay-explore.md"], differ: ["relay-worker.md"] }); });

// A parent directory is what someone naturally types at the project prompt, so setup has to find the repos under it.
test("discoverRepos finds repos one and two levels down, and never descends into one", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-disc-"));
  const mk = (p: string, git = false) => { mkdirSync(join(root, p), { recursive: true }); if (git) mkdirSync(join(root, p, ".git"), { recursive: true }); };
  mk("semapad", true);                       // depth 1 repo
  mk("project/relay", true);                 // depth 2 repo
  mk("project/kollegium", true);
  mk("project/plain");                       // not a repo
  mk("semapad/vendor/inner", true);          // inside a repo: must not be reported
  mk("node_modules/pkg", true);              // skipped by name
  mk(".hidden/repo", true);                  // skipped by name
  mk("a/b/c/deep", true);                    // deeper than maxDepth

  const found = discoverRepos(root).map((p) => p.slice(root.length + 1)).sort();
  expect(found).toEqual(["project/kollegium", "project/relay", "semapad"]);
});

// Gating the probe on the capabilities file merely existing meant `relay setup` after a `claude update` — the
// obvious thing to do — kept the stale measurements forever.
test("the wizard probes when nothing is measured, re-probes on drift, and stays quiet when the CLI matches", () => {
  expect(probeReason(false, "unknown", "2.1.251 (Claude Code)")).toBe("missing");
  expect(probeReason(true, "2.1.251", "2.4.0 (Claude Code)")).toBe("drift");     // minor bump: re-measure
  expect(probeReason(true, "2.1.251", "3.0.0")).toBe("drift");
  expect(probeReason(true, "2.1.251", "2.1.251 (Claude Code)")).toBeNull();      // in sync: no session, no usage
  expect(probeReason(true, "2.1.251", "2.1.299")).toBeNull();                    // patch bump is not worth a probe
  expect(probeReason(true, "unknown", "2.1.251")).toBeNull();                    // an unreadable version is not evidence of drift
});
