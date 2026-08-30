// spikes/scripts/06-spool.ts — ⑥ hook spool under faults: receiver down, restart drain, 20 concurrent, SIGKILL mid-write, malformed file.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, hookLines, record, RESULTS } from "./lib.ts";
const PORT = 8797, LOG = join(RESULTS, "06-spool.jsonl"), SPOOL = join(RESULTS, "spool"); rmSync(SPOOL, { recursive: true, force: true }); mkdirSync(SPOOL, { recursive: true });
rmSync(LOG, { force: true });
const HOOK = join(import.meta.dir, "hook-spool.ts"), URL = `http://127.0.0.1:${PORT}/hook`;
const fire = (i: number) => Bun.spawn(["bun", HOOK, "PostToolUse", SPOOL, URL], { stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s1", tool_use_id: `tu_${i}`, tool_name: "Bash" })), stdout: "ignore", stderr: "ignore" }).exited;
const files = () => readdirSync(SPOOL).filter((f) => f.endsWith(".json"));
// (a) receiver down → files accumulate
await Promise.all(Array.from({ length: 5 }, (_, i) => fire(i)));
const accumulated = files().length;
// (b) restart receiver → drain: relay's drain loop is `for each .json: POST; on 2xx unlink`
const hookd = Bun.spawn(["bun", join(import.meta.dir, "hookd.ts"), String(PORT), LOG], { stdout: "inherit", stderr: "inherit" }); await Bun.sleep(500);
for (const f of files()) { const r = await fetch(URL, { method: "POST", body: readFileSync(join(SPOOL, f), "utf8") }); if (r.ok) rmSync(join(SPOOL, f)); }
const drained = files().length === 0 && hookLines(LOG).length === accumulated;
// (c) 20 concurrent with receiver up → none left, 20 logged
await Promise.all(Array.from({ length: 20 }, (_, i) => fire(100 + i)));
const concurrent20 = files().length === 0 && hookLines(LOG).length === accumulated + 20;
// (d) SIGKILL mid-write → at most a .tmp file, never a truncated .json
const p = Bun.spawn(["bun", HOOK, "PostToolUse", SPOOL, "http://127.0.0.1:1/hook"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
p.stdin.write(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s1", tool_use_id: "tu_kill" })); p.kill("SIGKILL"); await p.exited;
const partial = readdirSync(SPOOL).filter((f) => f.endsWith(".json")).some((f) => { try { JSON.parse(readFileSync(join(SPOOL, f), "utf8")); return false; } catch { return true; } });
// (e) malformed file → quarantine
writeFileSync(join(SPOOL, "bad.json"), "{not json"); mkdirSync(join(SPOOL, "quarantine"), { recursive: true });
for (const f of files()) { try { JSON.parse(readFileSync(join(SPOOL, f), "utf8")); } catch { rmSync(join(SPOOL, f)); writeFileSync(join(SPOOL, "quarantine", f), "quarantined"); } }
const quarantined = existsSync(join(SPOOL, "quarantine", "bad.json"));
const spool = { lossWithoutSpool: "see races.restartVsHookPost", accumulated, drainAfterRestart: drained, concurrent20, sigkillPartial: partial, malformedQuarantined: quarantined };
record({ spool });
check("spool accumulates while receiver down", accumulated === 5); check("drain after restart", drained); check("20 concurrent", concurrent20); check("no truncated json after SIGKILL", !partial); check("malformed quarantined", quarantined);
hookd.kill();
