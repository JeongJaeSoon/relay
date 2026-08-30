import type { TaskStatus } from "@shared/types.ts";
export type StKey = "run" | "wait" | "queue" | "done" | "err" | "cancelled" | "closed";
/** Server status → the demo's 7 visual states (CSS classes st-<key>, sidebar groups, edge classes). */
export const stKey = (s: TaskStatus): StKey => s === "starting" || s === "running" ? "run" : s === "waiting_input" || s === "needs_review" ? "wait" : s === "queued" ? "queue" : s === "done" ? "done" : s === "error" ? "err" : s === "cancelled" ? "cancelled" : "closed";
export const stLabel = (s: TaskStatus): string => ({ queued: "대기열", starting: "시작 중", running: "실행 중", waiting_input: "응답 대기", done: "완료", needs_review: "검토 필요", error: "오류", cancelled: "중단됨", closed: "보관됨" })[s];
/** Browser-only globals behind guards so the pure modules also load under `bun test`. */
export const ls = {
  get: (k: string): string | null => { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } },
  set: (k: string, v: string) => { try { globalThis.localStorage?.setItem(k, v); } catch {} },
};
export const readToken = () => (typeof document === "undefined" ? "" : (document.querySelector('meta[name="relay-token"]')?.getAttribute("content") ?? ""));
