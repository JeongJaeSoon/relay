// src/lifecycle/foreign.ts — sessions on this machine that relay did NOT start: observed, never managed.
//
// There is no hook stream for a session relay never spawned (`--settings` is spawn-time only), so everything here comes
// from the roster poll the watchdog already does plus the session registry. That makes a foreign session a SNAPSHOT,
// not an event stream: it is kept in this in-memory projection, refreshed every tick, and never written to `tasks` and
// never appended to the event log. A row here has no project, no worktree, no permit, no queue position and no verdict.
import type { Database } from "bun:sqlite";
import type { ForeignSession } from "@shared/types.ts";
import { now } from "../core/clock.ts";
import type { AgentRow, AgentRunner } from "../runner/runner.ts";
import { sessionRegistryIndex } from "../runner/peer.ts";
import { jobWorktree, readOwner } from "./outbox.ts";
import { log as slog } from "../log.ts";

/** A roster row is only published as foreign once it has been unowned for this long. `claude --bg` puts a row on the
 *  roster before the outbox has recorded its short id or stamped its worktree (Outbox.waitRow waits up to 10s for the
 *  row to carry a cwd and a session id), so a worker relay is in the middle of spawning is briefly indistinguishable
 *  from a session someone else started. Waiting out that window is what keeps our own nascent worker out of this list. */
export const FOREIGN_GRACE_MS = 30_000;

/** Everything that makes a roster row relay's own. A name is NOT part of it: Phase 0 ⑦ measured two live sessions sharing one. */
export interface Ownership { sessionIds: Set<string>; shortIds: Set<string>; stamped(row: AgentRow): boolean }

/** Foreign = alive, has a session id (identity), and nothing says relay owns it. */
export function isForeign(row: AgentRow, own: Ownership): boolean {
  if (!row.alive || !row.session_id) return false;                          // a dead row is history; a row with no session id has no identity to track
  if (own.sessionIds.has(row.session_id)) return false;
  if (row.short_id && own.shortIds.has(row.short_id)) return false;
  return !own.stamped(row);
}
export const foreignRows = (rows: AgentRow[], own: Ownership): AgentRow[] => rows.filter((r) => isForeign(r, own));

/** Ownership as the database sees it. `process_instances` is included because a task that forked on `--resume` keeps
 *  its older session ids there — those are still sessions relay started, whatever the task row points at now. */
export function ownership(db: Database): Ownership {
  const col = (sql: string) => (db.query(sql).all() as { v: string | null }[]).map((r) => r.v).filter((v): v is string => !!v);
  return {
    sessionIds: new Set([...col("select session_id v from tasks"), ...col("select session_id v from process_instances")]),
    shortIds: new Set([...col("select short_id v from tasks"), ...col("select short_id v from process_instances")]),
    // Any `.relay-owner` stamp (not just this instance's) means the directory is relay's working area — its launch cwd
    // for a non-git project, or the worktree named in the job state file. Recovery matches the instance id because it
    // is deciding what to adopt; here the question is only "could this be ours?", and the safe answer is yes.
    stamped: (r) => !!readOwner(r.cwd) || !!readOwner(jobWorktree(r.short_id)),
  };
}

export interface Reduced { next: Map<string, ForeignSession>; published: ForeignSession[] }
/** Fold this tick's foreign rows into the tracked set. `first_seen` survives; anything off the roster is dropped. */
export function reduceForeign(prev: Map<string, ForeignSession>, rows: AgentRow[], t: number, registry: Map<string, { pid: number | null; started_at: number | null; kind: string | null }> = new Map(), graceMs = FOREIGN_GRACE_MS): Reduced {
  const next = new Map<string, ForeignSession>();
  for (const r of rows) {
    const id = r.session_id!; const p = prev.get(id); const reg = registry.get(id);
    next.set(id, { session_id: id, short_id: r.short_id, name: r.name, cwd: r.cwd, busy: r.busy,
      pid: reg?.pid ?? p?.pid ?? r.pid, started_at: reg?.started_at ?? p?.started_at ?? null, kind: reg?.kind ?? p?.kind ?? null,
      first_seen: p?.first_seen ?? t, last_seen: t });
  }
  const published = [...next.values()].filter((f) => t - f.first_seen >= graceMs).sort((a, b) => a.first_seen - b.first_seen || a.session_id.localeCompare(b.session_id));
  return { next, published };
}
const key = (f: ForeignSession) => JSON.stringify([f.session_id, f.short_id, f.name, f.cwd, f.busy, f.pid, f.started_at, f.kind]);
/** News = appeared, disappeared, or changed something the dashboard shows. `last_seen` alone is a heartbeat, and
 *  broadcasting it every 5s would be the flood this design exists to avoid. */
export function publishedChanged(a: ForeignSession[], b: ForeignSession[]): boolean {
  return a.length !== b.length || a.some((f, i) => key(f) !== key(b[i]!));
}

/** The projection itself. The watchdog is its only writer; the gateway is its only reader. */
export class ForeignSessions {
  private tracked = new Map<string, ForeignSession>();
  private published: ForeignSession[] = [];
  constructor(private db: Database, private runner: AgentRunner, private onChange: (list: ForeignSession[]) => void = () => {}) {}
  list(): ForeignSession[] { return this.published; }
  /** Called by the watchdog with the roster it already polled — no extra `claude agents` call, and no event per tick. */
  refresh(rows: AgentRow[], t = now()) {
    const foreign = foreignRows(rows, ownership(this.db));
    const { next, published } = reduceForeign(this.tracked, foreign, t, foreign.length ? sessionRegistryIndex() : undefined);   // the registry scan only happens when there is something to look up
    this.tracked = next; this.publish(published);
  }
  private publish(list: ForeignSession[]) {
    const changed = publishedChanged(list, this.published); this.published = list;
    if (changed) this.onChange(list);
  }
  /** The ONLY path in relay that stops a session it does not own, and it exists solely for an explicit click in the
   *  dashboard. No timer, reaper, kill switch or recovery pass can reach it: they all work from the `tasks` table, and a
   *  foreign session is never in it. The 5s-old poll is not trusted — the session is re-classified against a fresh
   *  roster here, so a row that has meanwhile become relay's own is refused. */
  async stop(sessionId: string): Promise<{ ok: true } | { ok: false; status: 404 | 409 | 503; error: string }> {
    let rows: AgentRow[];
    try { rows = await this.runner.list(true); } catch (e) { return { ok: false, status: 503, error: `agents --json failed: ${String(e)}` }; }
    const row = foreignRows(rows, ownership(this.db)).find((r) => r.session_id === sessionId);
    if (!row) return { ok: false, status: 404, error: "not an external session relay is watching" };
    if (!row.short_id) return { ok: false, status: 409, error: "the roster row has no short id — stop this session from its own terminal" };
    slog.info("stopping an external session on the user's request", { session: sessionId, short: row.short_id, name: row.name });
    await this.runner.stop(row.short_id);
    this.tracked.delete(sessionId); this.publish(this.published.filter((f) => f.session_id !== sessionId));   // the next poll confirms; the dashboard should not wait 5s to see it go
    return { ok: true };
  }
}
