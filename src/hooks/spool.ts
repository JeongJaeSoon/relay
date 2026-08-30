// src/hooks/spool.ts — drain the command-hook spool straight into ingest (no HTTP hop); quarantine what will not parse.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ingestHook, type IngestDeps } from "./ingest.ts";
export class Spool {
  constructor(private dir: string, private deps: () => IngestDeps) { mkdirSync(join(dir, "quarantine"), { recursive: true, mode: 0o700 }); }
  files() { return existsSync(this.dir) ? readdirSync(this.dir).filter((f) => f.endsWith(".json")).sort() : []; }
  /** Feed spooled hook files straight into ingest; delete on success, quarantine on parse failure. */
  async drain(): Promise<number> {
    let n = 0;
    for (const f of this.files()) {
      const p = join(this.dir, f); let rec: any;
      try { rec = JSON.parse(readFileSync(p, "utf8")); } catch { renameSync(p, join(this.dir, "quarantine", f)); continue; }
      try { ingestHook(rec.body, rec.headers ?? {}, this.deps(), { replay: true }); unlinkSync(p); n++; } catch { renameSync(p, join(this.dir, "quarantine", f)); }
    }
    return n;
  }
  sweep(days = 7): number { const cutoff = Date.now() - days * 86400_000; let n = 0; for (const sub of ["", "quarantine"]) for (const f of readdirSync(join(this.dir, sub))) { const p = join(this.dir, sub, f); if (statSync(p).isFile() && statSync(p).mtimeMs < cutoff) { unlinkSync(p); n++; } } return n; }
}
