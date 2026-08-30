// spikes/scripts/05-permits.ts — ⑤ can a PreToolUse(Agent) http hook deny subagent spawns beyond N, and does the worker continue sequentially?
import { rmSync } from "node:fs";
import { join } from "node:path";
import { check, fixture, hookLines, parseBg, record, RESULTS, SANDBOX, settings, sh, stopAndRm, waitFor } from "./lib.ts";
const PORT = 8796, LOG = join(RESULTS, "05-permits.jsonl");
rmSync(LOG, { force: true });
const hookd = Bun.spawn(["bun", join(import.meta.dir, "hookd.ts"), String(PORT), LOG, "--deny-agent-over", "1"], { stdout: "inherit", stderr: "inherit" }); await Bun.sleep(500);
const extra = { env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1", CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "10" } };
const bg = parseBg((await sh(["claude", "--bg", "-w", "relay-spike-permit", "-n", "relay-spike:permit", "--agent", "relay-worker", "--model", "claude-sonnet-5", "--effort", "low", "--permission-mode", "auto",
  "--settings", settings(PORT, undefined, extra),
  "Launch THREE relay-explore subagents in parallel (a single message with three Agent tool calls), each told to run `sleep 15` and then list files. If a spawn is denied, do that part yourself. Then RELAY: done listing which subagents ran and which you did yourself."], { cwd: SANDBOX, timeoutMs: 60_000 })).stdout)!;
const stop = await waitFor(async () => hookLines(LOG).find((l) => l.e === "Stop"), 300_000);
const pres = hookLines(LOG).filter((l) => l.e === "PreToolUse" && l.body.tool_name === "Agent");
const starts = hookLines(LOG).filter((l) => l.e === "SubagentStart");
const stops = hookLines(LOG).filter((l) => l.e === "SubagentStop");
if (starts[0]) fixture("subagent-start", starts[0].body); if (stops[0]) fixture("subagent-stop", stops[0].body);
const denied = pres.length - starts.length;
const parallel = starts.length >= 2 && Math.abs(starts[0].t - starts[1].t) < 3000;
const perm = { agentPreToolUse: pres.length, subagentStarts: starts.length, subagentStops: stops.length, denied, preToolUseDenyWorks: denied >= 1 && starts.length === 1,
  parallelObserved: parallel, denyReasonSeenByWorker: /myself|did .* (myself|sequential)/i.test(stop.body.last_assistant_message ?? ""), agentTypes: starts.map((s) => s.body.agent_type) };
record({ permit: perm });
check("PreToolUse(Agent) deny limits concurrent subagents to 1", perm.preToolUseDenyWorks, JSON.stringify(perm));
check("SubagentStart/Stop carry agent_id+agent_type", !!starts[0]?.body?.agent_id && !!starts[0]?.body?.agent_type);
await stopAndRm(bg.short); hookd.kill();
