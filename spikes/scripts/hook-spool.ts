// spikes/scripts/hook-spool.ts — prototype of `relay hook <event>`: stdin JSON → spool file (tmp → fsync → rename) → POST → delete on 2xx.
// usage: bun spikes/scripts/hook-spool.ts <event> <spoolDir> <url>
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
const [event, spoolDir, url] = process.argv.slice(2);
mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
const raw = await new Response(Bun.stdin.stream()).text();
let body: any; try { body = JSON.parse(raw); } catch { process.exit(0); }
const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
const rec = JSON.stringify({ id, event, received_at: Date.now(), body });
const tmp = join(spoolDir, `${id}.tmp`), fin = join(spoolDir, `${id}.json`);
const fd = openSync(tmp, "w", 0o600); writeSync(fd, rec); fsyncSync(fd); closeSync(fd); renameSync(tmp, fin);
try {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: rec, signal: AbortSignal.timeout(2000) });
  if (r.ok) unlinkSync(fin);
} catch {}
process.exit(0);
