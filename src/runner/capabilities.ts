import { existsSync, readFileSync } from "node:fs";
import type { DeliveryMethod } from "@shared/types.ts";
import { paths } from "../config.ts";

/** `cli_version` is the CLI the *whole* file was measured against (the Phase 0 spikes); `probe_cli_version` is the
 *  CLI `relay doctor --probe` last re-checked the `--bg --resume` gate against. They move independently. */
export interface Capabilities { delivery: DeliveryMethod; cli_version: string; probe_cli_version?: string; probed_at?: string; bgResume?: string; agentsJsonVocab?: unknown; peerRegistration?: boolean; socketAuthLine?: string; advisorFlag?: boolean; permit?: { preToolUseDenyWorks?: boolean } }

export function loadCapabilities(path = paths.capabilities): Capabilities {
  if (!existsSync(path)) return { delivery: "resume", cli_version: "unknown" };
  const j = JSON.parse(readFileSync(path, "utf8"));
  const delivery: DeliveryMethod = j.delivery === "socket" ? "socket" : "resume";   // `--bg --resume` is a Phase 0 go/no-go; there is no print fallback (roadmap C9)
  return { ...j, delivery, cli_version: typeof j.cli_version === "string" ? j.cli_version : "unknown" };   // a file written before relay read this key must still boot
}
/** The CLI the `--bg --resume` gate was last measured against — the probe's stamp, or the spikes' when nothing has
 *  re-probed since. It answers "has the gate been checked on this build?", which is a narrower question than drift. */
export const gateVersion = (c: Capabilities) => c.probe_cli_version ?? c.cli_version;

// Version helpers live here, not in cli/setup.ts, because serve.ts needs them and must not pull in the wizard's
// clack prompts and embedded agent files. setup.ts re-exports them for its own callers.
/** Takes anything: a capabilities.json can be missing cli_version entirely, and boot must not die on it. */
export const parseVersion = (s: unknown) => (typeof s === "string" ? s.match(/(\d+)\.(\d+)\.(\d+)/) ?? [] : []).slice(1, 4).map(Number);
export const versionOk = (s: string) => { const [a, b, c] = parseVersion(s); return a > 2 || (a === 2 && (b > 1 || (b === 1 && c >= 251))); };

export type DriftLevel = "same" | "patch" | "minor" | "major" | "unknown";
/** How far the CLI has moved since capabilities.json was measured. Distance only: a downgrade invalidates the
 *  measurements exactly as much as an upgrade does, so direction is not part of the answer. */
export function versionDrift(recorded: string, current: string): DriftLevel {
  const a = parseVersion(recorded), b = parseVersion(current);
  if (a.length !== 3 || b.length !== 3) return "unknown";                        // never probed ("unknown") or a `claude --version` we could not read
  if (a[0] !== b[0]) return "major";
  if (a[1] !== b[1]) return "minor";
  return a[2] !== b[2] ? "patch" : "same";
}
/** Any difference warns. Claude Code ships its release stream in the patch field — the supported floor is 2.1.251
 *  and a `claude update` to 2.1.3xx is the overwhelmingly common move — so a minor/major cut would almost never
 *  fire. Patch releases do move what relay measured: 2.1.251's `agents --json` vocabulary already differed from the
 *  CLI's own documentation (roadmap C7), and a patch release aligning to the docs would change exactly the value
 *  the spawn parser reads. The level stays in the detail text so the user can still judge severity. */
export const driftWarns = (level: DriftLevel) => level === "patch" || level === "minor" || level === "major";
/** `claude --version` prints "2.1.251 (Claude Code)" and capabilities.json stores it verbatim; only the number is
 *  worth showing back. Anything that does not parse (including the never-probed "unknown") stays as "unknown". */
export const showVersion = (s: string) => { const v = parseVersion(s); return v.length === 3 ? v.join(".") : "unknown"; };
/** `claude --version`, or "" when the binary is missing or hangs. No session, no auth — just the version line. */
export async function currentCliVersion(claudeBin: string, timeoutMs = 5_000): Promise<string> {
  try {
    const p = Bun.spawn([claudeBin, "--version"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const t = setTimeout(() => p.kill(), timeoutMs);
    const out = await new Response(p.stdout).text(); await p.exited; clearTimeout(t);
    return out.trim();
  } catch { return ""; }
}
