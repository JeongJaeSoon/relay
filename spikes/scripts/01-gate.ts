// spikes/scripts/01-gate.ts — ① CLI capability gate. Records flags/vocab and verifies --bg --resume, --settings hook merge, --agent precedence, --tools "", --json-schema.
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agents, check, fixture, hookLines, killHookds, parseBg, record, RESULTS, SANDBOX, settings, sh, spawnHookd, spikeAgents, stopAndRm, versionOk, waitFor } from "./lib.ts";

const PORT = 8791; const LOG = join(RESULTS, "01-gate-hooks.jsonl");
rmSync(LOG, { force: true });   // the script indexes the log by position, so a rerun must not see the previous run's lines
// Measured on the first run: a registered WorktreeCreate hook must return the worktree path, so it cannot be used for
// observation (see lib.ts ALL_EVENTS). The payload captured before that finding lives in fixtures/worktree-create.json.
record({ worktreeCreateHook: { role: "provider", observed: "session killed before init when the hook returns no path", error: "Error creating worktree: WorktreeCreate hook failed: hook succeeded but returned no worktree path (command: echo the path to stdout; http/callback: return hookSpecificOutput.worktreePath)" } });
spawnHookd(PORT, LOG);
await Bun.sleep(500);
const fails: string[] = [];
const must = (name: string, ok: boolean, detail = "") => { if (!check(name, ok, detail)) fails.push(name); };

// 1a. version + flags
const ver = (await sh(["claude", "--version"])).stdout.trim();
const help = (await sh(["claude", "--help"])).stdout;
const REQUIRED = ["--bg", "-n, --name", "-w, --worktree", "--settings", "--agent <agent>", "--permission-mode", "--effort", "--json-schema", "--tools", "--no-session-persistence", "--append-system-prompt", "--output-format", "-r, --resume", "--model"];
const flags = Object.fromEntries(REQUIRED.map((f) => [f, help.includes(f)]));
must("cli >= 2.1.251", versionOk(ver), ver);
must("required flags present", Object.values(flags).every(Boolean), JSON.stringify(flags));
record({ cli_version: ver, flags, advisorFlag: help.includes("--advisor"), restrictedFlag: help.includes("--restricted") });

// 1b. spawn a worker with inline settings hooks + --agent precedence check (agent frontmatter says effort low; CLI says high)
mkdirSync(join(homedir(), ".claude", "agents"), { recursive: true });
writeFileSync(join(homedir(), ".claude", "agents", "relay-spike-agent.md"),
  "---\nname: relay-spike-agent\ndescription: spike agent\neffort: low\n---\nYou are a spike agent. Reply with the single word OK and nothing else.\n");
const spawn = await sh(["claude", "--bg", "-w", "relay-spike-w1", "-n", "relay-spike:gate", "--agent", "relay-spike-agent",
  "--model", "claude-sonnet-5", "--effort", "high", "--permission-mode", "auto", "--settings", settings(PORT),
  "First try to Read the file /nonexistent/relay-spike.txt (it does not exist; just report the failure), then say OK"], { cwd: SANDBOX, timeoutMs: 60_000 });   // the failing Read yields a PostToolUseFailure payload for the fixtures
const bg = parseBg(spawn.stdout);
must("--bg prints short id", !!bg, spawn.stdout.trim() + spawn.stderr.trim());
const row = await waitFor(async () => (await spikeAgents()).find((a) => a.name === "relay-spike:gate"), 30_000);
const all = await agents(true);
const vocab = { state: [...new Set(all.map((a) => a.state).filter(Boolean))], status: [...new Set(all.map((a) => a.status).filter(Boolean))], kind: [...new Set(all.map((a) => a.kind).filter(Boolean))],
  waitingFor: [...new Set(all.map((a) => a.waitingFor).filter(Boolean))], keysByKind: Object.fromEntries(["background", "interactive"].map((k) => [k, [...new Set(all.filter((a) => a.kind === k).flatMap((a) => Object.keys(a)))]])) };
record({ agentsJsonSample: row, agentsJsonKeys: Object.keys(row), agentsJsonVocab: vocab, agentsJsonPidPresent: "pid" in row });
must("agents --json has sessionId,cwd,state", ["sessionId", "cwd", "state"].every((k) => k in row), JSON.stringify(row));
// Measured, contradicting the plan's assumption: background rows carry no `pid` (only interactive rows do), and `cwd`
// is the LAUNCH cwd, not the worktree — the worktree path only shows up in the hook payloads' `cwd`.
check("agents --json carries pid for a background session", "pid" in row, "absent → stop/crash confirmation cannot poll a pid; use state + SessionEnd");
check("agents --json cwd is the worktree", String(row.cwd).includes("relay-spike-w1"), `${row.cwd} → worktree path must come from the hook payload cwd`);
const stop = await waitFor(async () => hookLines(LOG).find((l) => l.e === "Stop"), 90_000);
const hookCwd = hookLines(LOG).find((l) => l.body?.session_id === row.sessionId && l.body?.cwd)?.body?.cwd ?? null;
const jobState = existsSync(join(homedir(), ".claude", "jobs", bg!.short, "state.json")) ? JSON.parse(readFileSync(join(homedir(), ".claude", "jobs", bg!.short, "state.json"), "utf8")) : null;
record({ worktreeCwd: { agentsJson: row.cwd, hookPayload: hookCwd, isWorktree: String(hookCwd).includes("relay-spike-w1") },
  jobStateKeys: jobState ? Object.keys(jobState) : null, jobStateHasRespawnFlags: !!jobState?.respawnFlags });
must("the -w worktree is the worker's real cwd (from the hook payload)", String(hookCwd).includes("relay-spike-w1"), String(hookCwd));
const pre = hookLines(LOG).filter((l) => l.e === "PreToolUse" || l.e === "UserPromptSubmit");
const effortSeen = (pre[0]?.body?.effort?.level) ?? stop.body?.effort?.level;
record({ agentFlagPrecedence: effortSeen === "high" ? "cli-wins" : effortSeen === "low" ? "frontmatter-wins" : "unknown:" + effortSeen });
must("--agent vs CLI flag precedence recorded", !!effortSeen, String(effortSeen));
must("Stop carries last_assistant_message", typeof stop.body.last_assistant_message === "string", stop.body.last_assistant_message);
must("PostToolUseFailure captured (failing Read)", hookLines(LOG).some((l) => l.e === "PostToolUseFailure"), "needed for the B4 fixture");
// C5: are hooks from other settings sources merged with --settings hooks, or replaced? Use the disposable sandbox's
// PROJECT settings as the canary source (never touch ~/.claude/settings.json). Same precedence question, zero risk.
mkdirSync(join(SANDBOX, ".claude"), { recursive: true });
const canaryCmd = `curl -s -m 2 -X POST -H 'content-type: application/json' --data-binary @- 'http://127.0.0.1:${PORT}/hook?e=ProjectCanary' >/dev/null 2>&1; exit 0`;
writeFileSync(join(SANDBOX, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: canaryCmd, timeout: 3 }] }] } }, null, 2));
try {
  // gate2 also probes SessionStart over http (settings(..., sessionStartHttp=true) — no command fallback), so any SessionStart from gate2 proves http delivery.
  const s2 = await sh(["claude", "--bg", "-n", "relay-spike:gate2", "--model", "claude-sonnet-5", "--effort", "low", "--permission-mode", "auto", "--settings", settings(PORT, ["SessionStart", "Stop", "SessionEnd"], {}, true), "say OK"], { cwd: SANDBOX, timeoutMs: 60_000 });
  const bg2 = parseBg(s2.stdout)!;
  const row2 = await waitFor(async () => (await spikeAgents()).find((a) => a.name === "relay-spike:gate2"), 30_000);
  await waitFor(async () => hookLines(LOG).some((l) => l.e === "Stop" && l.body.session_id === row2.sessionId), 90_000);
  await Bun.sleep(2000);
  const canary = hookLines(LOG).some((l) => l.e === "ProjectCanary");
  const ssHttp = hookLines(LOG).some((l) => l.e === "SessionStart" && l.body.session_id === row2.sessionId);
  record({ settingsHooksMerge: canary ? "merged" : "replaced", sessionStartHttp: ssHttp });
  check("--settings hooks merge behaviour observed (canary resolved)", typeof canary === "boolean", canary ? "project hooks still fire (merged)" : "project hooks suppressed (replaced)");
  check("SessionStart via http hook", ssHttp, ssHttp ? "arrives — command fallback optional" : "does not arrive — keep the command hook (§14.1)");
  await stopAndRm(bg2.short);
} finally { rmSync(join(SANDBOX, ".claude", "settings.json"), { force: true }); }

// 1c. stop → --bg --resume (C9). Also capture how a stopped session looks in `agents --json --all` (B3 stop confirmation relies on it).
await sh(["claude", "stop", bg!.short], { timeoutMs: 15_000 });
await waitFor(async () => hookLines(LOG).some((l) => l.e === "SessionEnd"), 30_000);
await Bun.sleep(1500);
const stopped = (await agents(true)).find((a) => a.id === bg!.short); fixture("agents-json-stopped", stopped ?? null);
record({ stopManifest: { present: !!stopped, pid: stopped?.pid ?? null, state: stopped?.state ?? null, status: stopped?.status ?? null } });
const before = hookLines(LOG).length;
const res = await sh(["claude", "--bg", "--resume", row.sessionId, "-n", "relay-spike:gate", "--settings", settings(PORT), "What word did you reply with before? Answer with that word only."], { cwd: row.cwd, timeoutMs: 60_000 });
const bgR = parseBg(res.stdout);
let bgResume = "fail";
if (bgR) {
  const st = await waitFor(async () => hookLines(LOG).slice(before).find((l) => l.e === "Stop"), 90_000).catch(() => null);
  bgResume = st && /OK/i.test(st.body.last_assistant_message ?? "") ? "context-kept" : st ? "resumed-no-context" : "no-stop";
  const ss = hookLines(LOG).slice(before).find((l) => l.e === "SessionStart");
  record({ bgResumeSessionStartSource: ss?.body?.source ?? null, bgResumeNewShortId: bgR.short });
}
record({ bgResume, bgResumeStdout: res.stdout.trim(), bgResumeStderr: res.stderr.trim().slice(0, 300) });
must("claude --bg --resume <uuid> works with context", bgResume === "context-kept", bgResume);
if (bgResume !== "context-kept") {
  const pr = await sh(["claude", "-p", "--resume", row.sessionId, "--output-format", "json", "What word did you reply with before? Answer with that word only."], { cwd: row.cwd, timeoutMs: 90_000 });
  const j = JSON.parse(pr.stdout || "{}");
  record({ printResume: /OK/i.test(j.result ?? "") ? "context-kept" : "fail" });
  check("fallback: claude -p --resume keeps context", /OK/i.test(j.result ?? ""), j.result);
}

// 1d. dispatcher flags: --tools "" + --json-schema + --no-session-persistence, from an empty cwd
const dcwd = join(RESULTS, "dispatcher-cwd"); mkdirSync(dcwd, { recursive: true });
const schema = JSON.stringify({ type: "object", additionalProperties: false, properties: { action: { type: "string", enum: ["new_task", "route_to_task", "answer_directly", "close_task"] }, confidence: { type: "string", enum: ["high", "low"] } }, required: ["action", "confidence"] });
const t0 = Date.now();
const dp = await sh(["claude", "-p", "--output-format", "json", "--json-schema", schema, "--max-turns", "1", "--tools", "", "--no-session-persistence",
  "--model", "claude-fable-5", "--effort", "low", "--append-system-prompt", "You are a router. Decide and answer only via the structured output.",
  "Active tasks: none. Message: 'auth 모듈 리팩토링 해줘'. Choose an action."], { cwd: dcwd, timeoutMs: 90_000 });
const dj = JSON.parse(dp.stdout || "{}");
record({ jsonSchema: !!dj.structured_output, dispatcherSample: { wall_ms: Date.now() - t0, duration_ms: dj.duration_ms, usage: dj.usage, cost: dj.total_cost_usd, structured_output: dj.structured_output, keys: Object.keys(dj) }, toolsEmpty: !hookLines(LOG).slice(-50).some((l) => l.e === "PreToolUse" && l.body.session_id === dj.session_id) });
must("--json-schema yields structured_output", dj.structured_output?.action === "new_task", JSON.stringify(dj.structured_output));
const persisted = existsSync(join(homedir(), ".claude", "projects")) && (await sh(["bash", "-c", `ls ~/.claude/projects/*/${dj.session_id}.jsonl 2>/dev/null | wc -l`])).stdout.trim() !== "0";
record({ noSessionPersistence: !persisted });
check("--no-session-persistence leaves no transcript", !persisted);

// 1e. --advisor (record only)
if (help.includes("--advisor")) {
  const adv = await sh(["claude", "--bg", "-n", "relay-spike:advisor", "--model", "claude-sonnet-5", "--effort", "low", "--permission-mode", "auto", "--advisor", "claude-fable-5", "--settings", settings(PORT, ["Stop", "SessionEnd"]), "say OK"], { cwd: SANDBOX, timeoutMs: 60_000 });
  const a = parseBg(adv.stdout); record({ advisorSpawn: a ? "ok" : "fail:" + adv.stderr.trim().slice(0, 200) });
  if (a) await stopAndRm(a.short);
}

fixture("agents-json", await agents(true));
fixture("hooks-gate", hookLines(LOG).map((l) => l.body));
record({ hookEventsCaptured: [...new Set(hookLines(LOG).map((l) => l.body?.hook_event_name).filter(Boolean))] });   // which B4 rows are measured vs doc-based
if (bgR) await stopAndRm(bgR.short); else await stopAndRm(bg!.short);
try { unlinkSync(join(homedir(), ".claude", "agents", "relay-spike-agent.md")); } catch {}
killHookds();
console.log(fails.length ? `\nGATE FAILED: ${fails.join(", ")}` : "\nGATE PASSED");
process.exit(fails.length ? 1 : 0);
