import type { TaskStatus } from "@shared/types.ts";
export type StKey = "run" | "wait" | "queue" | "done" | "err" | "cancelled" | "closed";
/** Server status → the demo's 7 visual states (CSS classes st-<key>, sidebar groups, edge classes). */
export const stKey = (s: TaskStatus): StKey => s === "starting" || s === "running" ? "run" : s === "waiting_input" || s === "needs_review" ? "wait" : s === "queued" ? "queue" : s === "done" ? "done" : s === "error" ? "err" : s === "cancelled" ? "cancelled" : "closed";
export const stLabel = (s: TaskStatus): string => ({ queued: "Queued", starting: "Starting", running: "Running", waiting_input: "Needs input", done: "Done", needs_review: "Needs review", error: "Error", cancelled: "Cancelled", closed: "Archived" })[s];
/** Browser-only globals behind guards so the pure modules also load under `bun test`. */
export const ls = {
  get: (k: string): string | null => { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } },
  set: (k: string, v: string) => { try { globalThis.localStorage?.setItem(k, v); } catch {} },
};
export const readToken = () => (typeof document === "undefined" ? "" : (document.querySelector('meta[name="relay-token"]')?.getAttribute("content") ?? ""));
