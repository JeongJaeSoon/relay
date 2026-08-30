// src/hooks/command-hook.ts — `relay hook <event>`: spool the payload durably (tmp→fsync→rename), then try the HTTP post.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config.ts";
import { redact } from "../core/redact.ts";
import { hookTokenFor } from "../gateway/auth.ts";

/** `--task <uuid> --gen <n> --url <api>` as written into the worker's settings by buildSettingsJson. A `--bg` session
 *  does not inherit relay's environment (the supervisor daemon starts it), so the arguments come first and the
 *  RELAY_* variables are only a fallback for contexts that do inherit them. */
export function parseHookArgs(argv: string[]) {
  const get = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : undefined; };
  return { task: get("task") || process.env.RELAY_TASK_UUID || "", gen: get("gen") || process.env.RELAY_GEN || "", url: get("url") || process.env.RELAY_API_URL || "http://127.0.0.1:8790", home: get("home") || process.env.RELAY_HOME || "" };
}
/** Per-task hook bearer. The worker never sees the secret: relay derives the token here, in its own process. */
const tokenFor = (task: string) => { try { return hookTokenFor(readFileSync(paths.hookToken, "utf8").trim(), task); } catch { return process.env.RELAY_HOOK_TOKEN ?? ""; } };

export async function runCommandHook(event: string, argv: string[] = []): Promise<never> {
  const raw = await new Response(Bun.stdin.stream()).text(); let body: any; try { body = JSON.parse(raw); } catch { process.exit(0); }
  const { task, gen, url, home } = parseHookArgs(argv); if (home) process.env.RELAY_HOME = home;   // the spool belongs to the relay instance that spawned this worker
  if (event === "SessionStart" || !body.hook_event_name) body.hook_event_name = event;
  body.relay_task_uuid = task || null; body.relay_gen = gen || null;
  const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const rec = JSON.stringify({ id, received_at: Date.now(), headers: { "x-relay-task": task, "x-relay-gen": gen }, body }, (_k, v) => (typeof v === "string" ? redact(v) : v));   // per value: spool files never hold raw secrets, and redacting the document would break the JSON
  mkdirSync(paths.spool, { recursive: true, mode: 0o700 });
  const tmp = join(paths.spool, `${id}.tmp`), fin = join(paths.spool, `${id}.json`);
  const fd = openSync(tmp, "w", 0o600); writeSync(fd, rec); fsyncSync(fd); closeSync(fd); renameSync(tmp, fin);
  try { const r = await fetch(`${url}/api/hooks`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(task)}`, "x-relay-task": task, "x-relay-gen": gen }, body: JSON.stringify(body), signal: AbortSignal.timeout(2500) }); if (r.ok) unlinkSync(fin); } catch {}
  process.exit(0);
}
