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

interface DisplayRow { row: AgentRow; managed: boolean; task_uuid: string | null; display_id: string | null; can_stop: boolean }

/** Rows the roster may display. Visibility and stop authority are deliberately separate: `--all` is the user's
 * retained roster, so terminal rows and rows carrying a Relay stamp remain useful even though Relay cannot stop them.
 * Only a task that the dashboard can currently represent suppresses its current roster identity. Historical
 * process_instances never suppress a retained generation. */
export function displayRows(db: Database, rows: AgentRow[], own = ownership(db)): DisplayRow[] {
  const tasks = db.query("select uuid, display_id, status, parent_uuid, session_id, short_id from tasks").all() as {
    uuid: string; display_id: string; status: string; parent_uuid: string | null; session_id: string | null; short_id: string | null
  }[];
  const byUuid = new Map(tasks.map((t) => [t.uuid, t]));
  const graphVisible = (t: typeof tasks[number]) => {
    if (t.status === "closed") return false;
    if (!t.parent_uuid) return true;                         // top-level queue cards are represented by the graph
    const seen = new Set<string>([t.uuid]); let parentId: string | null = t.parent_uuid;
    while (parentId) {
      if (seen.has(parentId)) return false;
      seen.add(parentId);
      const parent = byUuid.get(parentId);
      if (!parent || parent.status === "closed" || parent.status === "queued") return false;
      parentId = parent.parent_uuid;
    }
    return true;
  };
  const visible = tasks.filter(graphVisible);
  const represented = (r: AgentRow) => visible.some((t) => t.session_id === r.session_id || (!!r.short_id && t.short_id === r.short_id));
  const currentTask = (r: AgentRow) => tasks.find((t) => t.session_id === r.session_id || (!!r.short_id && t.short_id === r.short_id));
  const historical = db.query("select p.session_id, p.short_id, p.task_uuid, t.display_id from process_instances p join tasks t on t.uuid=p.task_uuid order by p.generation desc").all() as {
    session_id: string | null; short_id: string | null; task_uuid: string; display_id: string
  }[];
  return rows.filter((r) => !!r.session_id && !represented(r)).map((row) => {
    const stamp = readOwner(row.cwd) ?? readOwner(jobWorktree(row.short_id));
    const current = currentTask(row);
    const prior = current ? undefined : historical.find((p) => p.session_id === row.session_id || (!!row.short_id && p.short_id === row.short_id));
    return { row, managed: !!current || !!prior || !!stamp, task_uuid: current?.uuid ?? prior?.task_uuid ?? stamp?.task_uuid ?? null,
      display_id: current?.display_id ?? prior?.display_id ?? null, can_stop: isForeign(row, own) };
  });
}

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
const normalizedState = (r: AgentRow): ForeignSession["state"] => {
  const raw = String((r.raw as any)?.state ?? "").toLowerCase();
  if (raw === "done" || raw === "stopped" || raw === "failed") return raw;
  if (!r.alive) return "unknown";
  if (r.busy === false) return "idle";
  if (r.busy === true || raw === "working" || raw === "running") return "running";
  return "unknown";
};
/** Fold this tick's foreign rows into the tracked set. `first_seen` survives; anything off the roster is dropped. */
export function reduceForeign(prev: Map<string, ForeignSession>, rows: AgentRow[] | DisplayRow[], t: number, registry: Map<string, { pid: number | null; started_at: number | null; kind: string | null }> = new Map(), graceMs = FOREIGN_GRACE_MS): Reduced {
  const next = new Map<string, ForeignSession>();
  for (const item of rows) {
    const d: DisplayRow = "row" in item ? item : { row: item, managed: false, task_uuid: null, display_id: null, can_stop: item.alive };
    const r = d.row;
    const id = r.session_id!; const p = prev.get(id); const reg = registry.get(id); const state = normalizedState(r);
    const terminal = state === "done" || state === "stopped" || state === "failed";
    const rawStarted = Number((r.raw as any)?.startedAt); const rawKind = (r.raw as any)?.kind;
    next.set(id, { session_id: id, short_id: r.short_id, name: r.name, cwd: r.cwd, busy: r.busy,
      pid: terminal ? null : reg?.pid ?? p?.pid ?? r.pid,
      started_at: reg?.started_at ?? (Number.isFinite(rawStarted) ? rawStarted : null) ?? p?.started_at ?? null,
      kind: reg?.kind ?? (typeof rawKind === "string" && rawKind ? rawKind : null) ?? p?.kind ?? null,
      state, can_stop: d.can_stop, managed: d.managed, task_uuid: d.task_uuid, display_id: d.display_id,
      first_seen: p?.first_seen ?? t, last_seen: t });
  }
  const published = [...next.values()].filter((f) => f.state === "done" || f.state === "stopped" || f.state === "failed" || f.managed || t - f.first_seen >= graceMs)
    .sort((a, b) => a.first_seen - b.first_seen || a.session_id.localeCompare(b.session_id));
  return { next, published };
}
const key = (f: ForeignSession) => JSON.stringify([f.session_id, f.short_id, f.name, f.cwd, f.busy, f.pid, f.started_at, f.kind, f.state, f.can_stop, f.managed, f.task_uuid, f.display_id]);
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
    const displayed = displayRows(this.db, rows);
    const { next, published } = reduceForeign(this.tracked, displayed, t, displayed.length ? sessionRegistryIndex() : undefined);   // the registry scan only happens when there is something to look up
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
