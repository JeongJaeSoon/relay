// web/src/notify.ts — pure notification rules (demo notify/withdrawNotif), driven by server task transitions.
import type { Task } from "@shared/types.ts";
export type NotifKind = "wait" | "err" | "done";
export interface NotifAdd { kind: NotifKind; taskUuid: string; title: string; body: string }
export function diffNotifs(prev: Task, next: Task): { add: NotifAdd[]; withdraw: { taskUuid: string; kind?: NotifKind }[] } {
  const add: NotifAdd[] = []; const withdraw: { taskUuid: string; kind?: NotifKind }[] = [];
  if (next.parent_uuid || prev.status === next.status) return { add, withdraw };
  const u = next.uuid; const mk = (kind: NotifKind, body: string) => add.push({ kind, taskUuid: u, title: next.title, body });
  if (next.status === "closed") { withdraw.push({ taskUuid: u }); return { add, withdraw }; }
  if (prev.status === "waiting_input") withdraw.push({ taskUuid: u, kind: "wait" });
  // demo restartTask withdraws `err` before gateRun: a retry that lands in the queue first (no permit) must clear the notification too
  if (["error", "cancelled", "needs_review"].includes(prev.status) && ["queued", "starting", "running"].includes(next.status)) withdraw.push({ taskUuid: u, kind: "err" });
  if (next.status === "waiting_input") mk("wait", next.question?.text ?? "An answer is needed");
  else if (next.status === "error") mk("err", "Session error — needs a restart"); else if (next.status === "cancelled") mk("err", "Cancelled"); else if (next.status === "needs_review") mk("err", `Needs review — ${next.last_summary ?? ""}`);
  else if (next.status === "done") mk("done", next.last_summary ?? "Done");
  return { add, withdraw };
}
