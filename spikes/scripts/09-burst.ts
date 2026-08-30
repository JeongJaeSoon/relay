// spikes/scripts/09-burst.ts — ⑨ 50-message serial chain through the dispatcher; timeout kill; kill switch stop/resume of 3 workers.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { check, hookLines, killHookds, parseBg, record, RESULTS, SANDBOX, settings, sh, spawnHookd, spikeAgents, stopAndRm, waitFor } from "./lib.ts";
import { decide, type Ctx } from "./dispatch.ts";
const ctx: Ctx = { projects: [{ name: "myapp", path: "/tmp/myapp", description: "웹앱", keywords: ["auth", "api", "react"] }, { name: "infra", path: "/tmp/infra", description: "배포 스크립트", keywords: ["terraform", "k8s"] }],
  tasks: [{ id: "T-01", title: "auth 리팩토링", project: "myapp", status: "running", last_summary: "auth 모듈 분리 중", last_active: "2분 전" }, { id: "T-02", title: "k8s 매니페스트 정리", project: "infra", status: "waiting_input", last_summary: "namespace 이름 질문 중", last_active: "10분 전" }], recent: [] };
const CASES: [string, string][] = [["auth에 테스트도 추가해줘", "route_to_task"], ["prod 네임스페이스로 해", "route_to_task"], ["myapp 로그인 페이지 다크모드 지원", "new_task"], ["terraform state 잠금 풀어줘", "new_task"], ["T-01 마무리하고 닫아", "close_task"],
  ["React 19에서 useEffect 두 번 도는 이유가 뭐야", "answer_directly"], ["그거 어떻게 됐어", "route_to_task"], ["README 오타 고쳐줘 myapp", "new_task"], ["k8s 작업 취소해", "close_task"], ["auth 리팩토링 결과 요약해줘", "route_to_task"]];
const runs: any[] = [];
// The plan asks for 50 messages. ① measured the real cost of one dispatcher call (`dispatcherSample`): ~104k cache
// -creation tokens and ~$2 of list-price usage, because `claude -p` still loads its full system prompt. 50 calls is not
// the "modest usage" this phase is allowed, so the chain runs each of the 10 cases exactly once; `stats.n` records it.
const N = Number(process.env.BURST_N ?? 10);
for (let i = 0; i < N; i++) { const [text, expect] = CASES[i % CASES.length]; const r = await decide(text, ctx); runs.push({ text, expect, got: r.decision?.action, ok: r.decision?.action === expect, ...r.meta }); process.stdout.write(runs.at(-1).ok ? "." : "x"); }
const ms = runs.map((r) => r.wall_ms).sort((a, b) => a - b);
const stats = { n: runs.length, p50_ms: ms[Math.floor(ms.length * 0.5)], p95_ms: ms[Math.floor(ms.length * 0.95)], accuracy: runs.filter((r) => r.ok).length / runs.length,
  tokens_per_call: runs.reduce((a, r) => a + ((r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0) + (r.usage?.cache_creation_input_tokens ?? 0) + (r.usage?.cache_read_input_tokens ?? 0)), 0) / runs.length,
  cost_per_call: runs.reduce((a, r) => a + (r.cost ?? 0), 0) / runs.length, errors: runs.filter((r) => r.is_error || r.code !== 0).length };
console.log("\n", stats); record({ dispatcher: stats, dispatcherRuns: runs.slice(0, 10) });
check("dispatcher accuracy >= 0.9", stats.accuracy >= 0.9, String(stats.accuracy));
// timeout: 1s budget → SIGTERM → exit code 143 expected (headless doc), no hang
const t = await decide("아무거나", ctx, "claude-fable-5", "low", 1000);
record({ dispatcherTimeoutKill: { code: t.meta.code, wall_ms: t.meta.wall_ms } });
check("timeout kill returns promptly", t.meta.wall_ms < 5000 && t.decision === null, JSON.stringify(t.meta));
// kill switch: 3 workers running sleep 90 → stop all → resume all → context kept
const PORT = 8800, LOG = join(RESULTS, "09-kill.jsonl");
rmSync(LOG, { force: true });
spawnHookd(PORT, LOG); await Bun.sleep(500);
const ws = [] as any[];
for (let i = 0; i < 3; i++) ws.push(parseBg((await sh(["claude", "--bg", "-w", `relay-spike-k${i}`, "-n", `relay-spike:kill${i}`, "--model", "claude-sonnet-5", "--effort", "low", "--permission-mode", "auto", "--settings", settings(PORT), `Remember the code word ZEBRA-${i}. Then run \`sleep 90\` with Bash and reply DONE.`], { cwd: SANDBOX, timeoutMs: 60_000 })).stdout)!);
await waitFor(async () => hookLines(LOG).filter((l) => l.e === "PreToolUse" && l.body.tool_name === "Bash").length >= 3, 120_000);
const t1 = Date.now(); await Promise.all(ws.map((w) => sh(["claude", "stop", w.short], { timeoutMs: 20_000 })));
const stoppedAll = await waitFor(async () => (await spikeAgents(true)).filter((a) => a.name?.startsWith("relay-spike:kill") && a.state === "working").length === 0, 30_000).then(() => Date.now() - t1).catch(() => -1);
const rows = (await spikeAgents(true)).filter((a) => a.name?.startsWith("relay-spike:kill"));
const resumed = await Promise.all(rows.map((r) => sh(["claude", "--bg", "--resume", r.sessionId, "-n", r.name, "--settings", settings(PORT), "What was the code word? Reply with it only."], { cwd: r.cwd, timeoutMs: 60_000 })));
const kept = await waitFor(async () => { const s = hookLines(LOG).filter((l) => l.e === "Stop" && /ZEBRA-\d/.test(l.body.last_assistant_message ?? "")); return s.length >= 3 ? s.length : null; }, 180_000).catch(() => 0);
record({ killSwitch: { stoppedAllMs: stoppedAll, resumedWithContext: kept, resumeSpawned: resumed.filter((r) => parseBg(r.stdout)).length } });
check("kill switch: stop all within 30s", stoppedAll >= 0, String(stoppedAll)); check("resume-all keeps context", kept === 3, String(kept));
for (const r of (await spikeAgents(true)).filter((a) => a.name?.startsWith("relay-spike:kill"))) await stopAndRm(r.id);
killHookds();
