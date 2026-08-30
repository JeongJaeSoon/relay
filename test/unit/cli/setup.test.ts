import { expect, test } from "bun:test";
import { parseVersion, versionOk, tomlStringify, planAgentInstall } from "../../../src/cli/setup.ts";
import { parseConfig } from "../../../src/config.ts";
test("version parsing", () => { expect(parseVersion("2.1.251 (Claude Code)")).toEqual([2, 1, 251]); expect(versionOk("2.1.251")).toBe(true); expect(versionOk("2.1.250")).toBe(false); expect(versionOk("2.2.0")).toBe(true); });
test("toml round trip", () => { const c = parseConfig("port = 9001\npath_prepend = [\"/opt/x/bin\"]\n[dispatcher]\nmodel = \"claude-opus-5\"\n"); const back = parseConfig(tomlStringify(c)); expect(back.port).toBe(9001); expect(back.path_prepend).toEqual(["/opt/x/bin"]); expect(back.dispatcher.model).toBe("claude-opus-5"); expect(back.worker.effort.normal).toBe("xhigh"); });
test("agent install plan", () => { expect(planAgentInstall({ "relay-worker.md": "old", "relay-explore.md": "x", "relay-verify.md": null }, { "relay-worker.md": "new", "relay-explore.md": "x", "relay-verify.md": "v" })).toEqual({ copy: ["relay-verify.md"], same: ["relay-explore.md"], differ: ["relay-worker.md"] }); });
