// src/hooks/command-hook.ts — `relay hook <event>`: spool the payload durably (tmp→fsync→rename), then try the HTTP post.
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config.ts";
import { redact } from "../core/redact.ts";
export async function runCommandHook(event: string): Promise<never> {
  const raw = await new Response(Bun.stdin.stream()).text(); let body: any; try { body = JSON.parse(raw); } catch { process.exit(0); }
  if (event === "SessionStart" || !body.hook_event_name) body.hook_event_name = event;
  body.relay_task_uuid = process.env.RELAY_TASK_UUID ?? null; body.relay_gen = process.env.RELAY_GEN ?? null;
  const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const rec = JSON.stringify({ id, received_at: Date.now(), headers: { "x-relay-task": process.env.RELAY_TASK_UUID ?? "", "x-relay-gen": process.env.RELAY_GEN ?? "" }, body }, (_k, v) => (typeof v === "string" ? redact(v) : v));   // per value: spool files never hold raw secrets, and redacting the document would break the JSON
  mkdirSync(paths.spool, { recursive: true, mode: 0o700 });
  const tmp = join(paths.spool, `${id}.tmp`), fin = join(paths.spool, `${id}.json`);
  const fd = openSync(tmp, "w", 0o600); writeSync(fd, rec); fsyncSync(fd); closeSync(fd); renameSync(tmp, fin);
  const url = `${process.env.RELAY_API_URL ?? "http://127.0.0.1:8790"}/api/hooks`; const token = process.env.RELAY_HOOK_TOKEN ?? (() => { try { return readFileSync(paths.hookToken, "utf8").trim(); } catch { return ""; } })();
  try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-relay-task": process.env.RELAY_TASK_UUID ?? "", "x-relay-gen": process.env.RELAY_GEN ?? "" }, body: JSON.stringify(body), signal: AbortSignal.timeout(2500) }); if (r.ok) unlinkSync(fin); } catch {}
  process.exit(0);
}
