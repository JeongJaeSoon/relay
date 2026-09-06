import { normalizeAgentRow } from "../../src/runner/native.ts";

export type ProbeCleanupDeps = {
  list(): Promise<any[]>;
  stop(shortId: string): Promise<void>;
  rm(shortId: string): Promise<void>;
};

export const isScopedProbeAgent = (raw: any, sandbox: string) =>
  String(raw?.name ?? "").startsWith("relay-spike:") && (raw?.cwd === sandbox || String(raw?.cwd ?? "").startsWith(`${sandbox}/`));

type ProbeIdentity = { id: string; sessionId: string; name: string; cwd: string };

function probeIdentity(raw: any): ProbeIdentity | null {
  const id = raw?.id == null ? "" : String(raw.id);
  const sessionId = raw?.sessionId == null ? "" : String(raw.sessionId);
  const name = raw?.name == null ? "" : String(raw.name);
  const cwd = raw?.cwd == null ? "" : String(raw.cwd);
  return id && sessionId && name && cwd ? { id, sessionId, name, cwd } : null;
}

function isSameScopedProbe(raw: any, identity: ProbeIdentity, sandbox: string) {
  const after = probeIdentity(raw);
  return isScopedProbeAgent(raw, sandbox) && after != null && after.id === identity.id && after.sessionId === identity.sessionId && after.name === identity.name && after.cwd === identity.cwd;
}

async function roster(deps: ProbeCleanupDeps) {
  const rows = await deps.list();
  if (!Array.isArray(rows)) throw new Error("Claude roster is not an array; cleanup status is unknown");
  return rows;
}

/** The roster is authoritative: absence means gone, only known terminal CLI states permit rm,
 * and an unfamiliar row blocks cleanup rather than guessing it is safe. */
export function cleanupDisposition(raw: any): "gone" | "stopped" | "active" | "unknown" {
  if (!raw) return "gone";
  const state = String(raw.state ?? ""); const normalized = normalizeAgentRow(raw);
  // normalizeAgentRow correctly treats terminal state as dead for normal observation. Before a
  // destructive rm, however, a terminal label combined with a running PID or busy status is
  // contradictory evidence, so leave it for an operator rather than guessing the PID is stale.
  if (["stopped", "done", "failed"].includes(state)) {
    const status = String(raw.status ?? "").toLowerCase();
    if (raw.pid != null || ["busy", "working"].includes(status)) return "unknown";
    return "stopped";
  }
  if (normalized.alive) return "active";
  return "unknown";
}

async function stopAndRemoveKnown(deps: ProbeCleanupDeps, sandbox: string, known: any) {
  const identity = probeIdentity(known);
  if (!identity || !isScopedProbeAgent(known, sandbox)) throw new Error(`Refusing cleanup outside the probe sandbox: ${String(known?.id ?? "unknown")}`);
  // A row selected by cleanupScopedProbes can vanish while another selected row is processed.
  // That is a successful cleanup, but a reused short ID is not.
  const current = (await roster(deps)).find((row) => row?.id === identity.id);
  if (!current) return;
  if (!isSameScopedProbe(current, identity, sandbox)) throw new Error(`Probe identity changed before stop: ${identity.id}`);
  await deps.stop(identity.id);
  const after = (await roster(deps)).find((row) => row?.id === identity.id);
  const disposition = cleanupDisposition(after);
  if (disposition === "gone") return;
  if (!isSameScopedProbe(after, identity, sandbox)) throw new Error(`Probe identity changed after stop: ${identity.id}`);
  if (disposition !== "stopped") throw new Error(`Session still ${disposition}: ${identity.id}`);
  await deps.rm(identity.id);
}

export async function stopAndRemove(deps: ProbeCleanupDeps, sandbox: string, shortId: string) {
  const before = (await roster(deps)).find((row) => row?.id === shortId);
  if (!before) throw new Error(`Refusing cleanup outside the probe sandbox: ${shortId}`);
  await stopAndRemoveKnown(deps, sandbox, before);
}

/** Attempt every scoped row even after an individual stop/rm failure, then make the incomplete
 * cleanup visible to the caller so the live probe exits non-zero. */
export async function cleanupScopedProbes(deps: ProbeCleanupDeps, sandbox: string) {
  const scoped = (await roster(deps)).filter((row) => isScopedProbeAgent(row, sandbox));
  const failures: unknown[] = [];
  for (const row of scoped) {
    try { await stopAndRemoveKnown(deps, sandbox, row); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, `Probe cleanup incomplete (${failures.length} session${failures.length === 1 ? "" : "s"})`);
}
