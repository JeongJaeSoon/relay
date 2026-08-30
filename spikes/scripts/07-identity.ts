// spikes/scripts/07-identity.ts — ⑦ identity & orphans: duplicate names, .relay-owner file, deleted cwd, rm on dirty worktree, ~/.claude/jobs/<id>/state.json
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agents, check, fixture, parseBg, record, SANDBOX, settings, sh, spikeAgents, stopAndRm, waitFor } from "./lib.ts";
const S = settings(8798, ["Stop", "SessionEnd"]);
const spawn = async (w: string, prompt: string) => parseBg((await sh(["claude", "--bg", "-w", w, "-n", "relay-spike:same", "--model", "claude-sonnet-5", "--effort", "low", "--permission-mode", "auto", "--settings", S, prompt], { cwd: SANDBOX, timeoutMs: 60_000 })).stdout)!;
const a = await spawn("relay-spike-id1", "reply OK"); const b = await spawn("relay-spike-id2", "reply OK");
const rows = await waitFor(async () => { const r = await spikeAgents(); return r.filter((x) => x.name?.startsWith("relay-spike:same")).length >= 2 ? r : null; }, 30_000);
const names = rows.map((r) => r.name);
// the worktree is the worker's real cwd (Task 1: agents --json.cwd is the launch cwd), so place the owner file there
const wt = (short: string, w: string) => join(SANDBOX, ".claude", "worktrees", w);
const owner = join(wt(a.short, "relay-spike-id1"), ".relay-owner");
if (existsSync(wt(a.short, "relay-spike-id1"))) writeFileSync(owner, JSON.stringify({ relay_instance_id: "spike", task_uuid: "t1" }));
const state = join(homedir(), ".claude", "jobs", a.short, "state.json");
const jobState = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : null; if (jobState) fixture("job-state", jobState);
// dirty worktree: write an uncommitted file then rm
const wtB = wt(b.short, "relay-spike-id2");
if (existsSync(wtB)) writeFileSync(join(wtB, "dirty.txt"), "x");
await sh(["claude", "stop", b.short]); await sh(["claude", "rm", b.short]);
const dirtyKept = existsSync(join(wtB, "dirty.txt"));
// deleted cwd: remove the worktree dir under a stopped session and see what agents --json reports
await sh(["claude", "stop", a.short]); rmSync(wt(a.short, "relay-spike-id1"), { recursive: true, force: true });
const after = (await agents(true)).find((r) => r.id === a.short);
const identity = { sameNameTwice: names, ownerFileSurvives: existsSync(owner) === false ? "cwd-removed" : "n/a", cwdDeletedAgentsJson: after ?? null, rmDirtyKeepsWorktree: dirtyKept, jobStateJson: jobState ? Object.keys(jobState) : null };
record({ identity });
check("two sessions may share a name (relay must key on sessionId)", names.filter((n) => n === "relay-spike:same").length === 2 || names.length === 2, JSON.stringify(names));
check("claude rm keeps dirty worktree", dirtyKept);
await sh(["claude", "rm", a.short]); await sh(["git", "worktree", "prune"], { cwd: SANDBOX });
for (const s of await spikeAgents(true)) await stopAndRm(s.id);
