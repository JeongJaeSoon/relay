// src/hooks/spool.ts — drain the command-hook spool straight into ingest (no HTTP hop); quarantine what will not parse.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ingestHook, type IngestDeps } from "./ingest.ts";
import { getMeta } from "../db/db.ts";
export class Spool {
  constructor(private dir: string, private deps: () => IngestDeps) { mkdirSync(join(dir, "quarantine"), { recursive: true, mode: 0o700 }); }
  files() { return existsSync(this.dir) ? readdirSync(this.dir).filter((f) => f.endsWith(".json")).sort() : []; }
  /** During recovery merge both durable transports by arrival time. Draining one transport first can
   *  deliver SessionEnd ahead of the earlier Stop in the other and make the completion look stale. */
  async drain(options: { includeInbox?: boolean } = {}): Promise<number> {
    let n = 0; const deps = this.deps();
    if (!options.includeInbox && getMeta(deps.db, "recovering") === "1") return 0;
    const pending: { at: number; body: any; headers: any; path?: string; file?: string; inboxId?: number }[] = [];
    for (const f of this.files()) {
      const p = join(this.dir, f); let rec: any;
      try { rec = JSON.parse(readFileSync(p, "utf8")); } catch { renameSync(p, join(this.dir, "quarantine", f)); continue; }
      if (!rec || typeof rec.body !== "object" || rec.body === null) { renameSync(p, join(this.dir, "quarantine", f)); continue; }
      pending.push({ at: Number.isFinite(rec.received_at) ? rec.received_at : statSync(p).mtimeMs, body: rec.body, headers: rec.headers ?? {}, path: p, file: f });
    }
    if (options.includeInbox) for (const r of deps.db.query("select * from hook_inbox order by id").all() as any[]) {
      pending.push({ at: r.received_at, body: JSON.parse(r.body_json), headers: JSON.parse(r.headers_json), inboxId: r.id });
    }
    const rank: Record<string, number> = { SessionStart: 0, SubagentStart: 1, SubagentStop: 3, Stop: 4, SessionEnd: 5 };
    pending.sort((a, b) => a.at - b.at || (rank[a.body.hook_event_name] ?? 2) - (rank[b.body.hook_event_name] ?? 2));
    for (const rec of pending) {
      try {
        ingestHook(rec.body, rec.headers, deps, { replay: true });
        if (rec.path) { unlinkSync(rec.path); n++; }
        else deps.db.run("delete from hook_inbox where id=?", [rec.inboxId!]);
      } catch (e) {
        if (rec.path) renameSync(rec.path, join(this.dir, "quarantine", rec.file!));
        else throw e; // keep an inbox row that could not be applied
      }
    }
    return n;
  }
  sweep(days = 7): number { const cutoff = Date.now() - days * 86400_000; let n = 0; for (const sub of ["", "quarantine"]) for (const f of readdirSync(join(this.dir, sub))) { const p = join(this.dir, sub, f); if (statSync(p).isFile() && statSync(p).mtimeMs < cutoff) { unlinkSync(p); n++; } } return n; }
}
