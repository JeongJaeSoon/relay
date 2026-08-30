// src/cli/db.ts — `relay db backup|restore|sweep|rebuild` plus the offline project registration `relay setup` falls back to.
import { copyFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import type { Project } from "@shared/types.ts";
import { loadConfig, paths } from "../config.ts";
import { openDb, migrate } from "../db/db.ts";
import { EventLog } from "../core/events.ts";
import { rebuildProjections } from "../core/replay.ts";
import { now } from "../core/clock.ts";
import { ulid } from "../core/ids.ts";
import { sweep } from "../lifecycle/retention.ts";
import { CliError, client } from "./client.ts";

const say = (s: string) => process.stdout.write(s + "\n");
const refuseIfUp = async (what: string) => { if (await client().up()) throw new CliError(`relay: 서버가 실행 중입니다 — ${what} 전에 \`brew services stop relay\`(또는 relay serve 종료)`); };
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

export async function db(rest: string[]) {
  const [sub, ...args] = rest;
  switch (sub) {
    case "backup": return backup(args[0]);
    case "restore": return restore(args[0]);
    case "sweep": return sweepCmd();
    case "rebuild": return rebuild();
    default: throw new CliError("usage: relay db backup [file] | restore <file> | sweep | rebuild", 2);
  }
}

/** `vacuum into` writes a consistent snapshot even while the server is writing — no SQLITE_BUSY, no half copy. */
function backup(dest = `${paths.db}.bak-${stamp()}`) {
  if (!existsSync(paths.db)) throw new CliError(`relay: DB가 없습니다: ${paths.db}`);
  const tmp = `${dest}.tmp`; if (existsSync(tmp)) unlinkSync(tmp);
  const d = openDb(paths.db); try { d.run("vacuum into ?", [tmp]); } finally { d.close(); }
  renameSync(tmp, dest); say(`백업 완료: ${dest}`);
}

async function restore(file?: string) {
  if (!file) throw new CliError("usage: relay db restore <file>", 2);
  if (!existsSync(file)) throw new CliError(`relay: 백업 파일이 없습니다: ${file}`);
  await refuseIfUp("복원");
  if (existsSync(paths.db)) { const keep = `${paths.db}.pre-restore-${stamp()}`; renameSync(paths.db, keep); say(`현재 DB 보관: ${keep}`); }
  for (const suffix of ["-wal", "-shm"]) { const f = paths.db + suffix; if (existsSync(f)) unlinkSync(f); }   // stale WAL of the replaced db would be applied to the restored one
  copyFileSync(file, paths.db); say(`복원 완료: ${file} → ${paths.db}`);
}

function sweepCmd() {
  const cfg = loadConfig(); const d = openDb(paths.db); migrate(d);
  try { const r = sweep(d, 90, new EventLog(d, () => {}, cfg)); say(`정리 완료: 이벤트 ${r.events}건 · blob ${r.blobs}건${r.vacuumed ? " · VACUUM 실행" : ""}`); } finally { d.close(); }
}

async function rebuild() {
  await refuseIfUp("프로젝션 재생성");
  const cfg = loadConfig(); const d = openDb(paths.db); migrate(d);
  try { say(`재생 완료: 이벤트 ${rebuildProjections(d, cfg)}건`); } finally { d.close(); }
}

/** `relay setup` path when the server is down: emit project.registered straight into the log (the log is the source of truth). */
export async function registerProjectOffline(p: { name: string; path: string; description: string; keywords: string[]; is_git: boolean }) {
  const cfg = loadConfig(); const d = openDb(paths.db); migrate(d);
  try {
    const existing = d.query("select id from projects where name=?").get(p.name) as { id: string } | null;   // names are unique: re-registering the same name updates it
    const payload: Project = { id: existing?.id ?? ulid(), name: p.name, path: p.path, description: p.description, keywords: p.keywords, base_ref: "fresh", is_git: p.is_git, created_at: now() };
    new EventLog(d, () => {}, cfg).emit({ type: "project.registered", payload });
    return payload.id;
  } finally { d.close(); }
}
