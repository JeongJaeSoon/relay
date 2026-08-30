// spikes/scripts/hookd.ts — hook receiver used by every spike.
// usage: bun spikes/scripts/hookd.ts <port> <outfile.jsonl> [--deny-agent-over N] [--hold-perm <ms>]
// env: PERM_DECISION=allow|deny  (answer PermissionRequest hooks; with --hold-perm the answer is delayed — Task 6 Step 4)
import { appendFileSync } from "node:fs";
const [portArg, out, ...rest] = process.argv.slice(2);
const opt = (k: string) => (rest.includes(k) ? Number(rest[rest.indexOf(k) + 1]) : undefined);
const denyOver = opt("--deny-agent-over") ?? Infinity; const holdPerm = opt("--hold-perm") ?? 0;
let activeAgents = 0;
Bun.serve({
  port: Number(portArg), hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url); const raw = await req.text();
    let body: any; try { body = JSON.parse(raw); } catch { body = { raw }; }
    const e = url.searchParams.get("e") ?? body.hook_event_name ?? "?";   // query wins: lets a canary command hook tag itself
    appendFileSync(out, JSON.stringify({ t: Date.now(), e, auth: req.headers.has("authorization"), body }) + "\n");
    let reply: unknown = {};
    if (e === "PreToolUse" && body.tool_name === "Agent") {
      if (activeAgents >= denyOver) reply = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "relay-spike: no slot — do it yourself sequentially" } };
      else activeAgents++;
    }
    if (e === "SubagentStop") activeAgents = Math.max(0, activeAgents - 1);
    if (e === "PermissionRequest" && process.env.PERM_DECISION) {
      if (holdPerm) { appendFileSync(out, JSON.stringify({ t: Date.now(), e: "PermissionHoldStart", body: { tool_use_id: body.tool_use_id } }) + "\n"); await Bun.sleep(holdPerm); appendFileSync(out, JSON.stringify({ t: Date.now(), e: "PermissionHoldEnd", body: { tool_use_id: body.tool_use_id } }) + "\n"); }
      reply = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: process.env.PERM_DECISION } } };
    }
    return Response.json(reply);
  },
});
console.log(`hookd listening on ${portArg} → ${out}`);
