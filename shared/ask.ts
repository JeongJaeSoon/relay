// shared/ask.ts — Ask mode's marker, shared by the gateway, the dispatcher and the dashboard.
// A question is declared at submission (the `ask` field on POST /api/messages, or the `?` prefix the user typed).
// The gateway normalises both into one canonical prefix on the stored text: that is what survives a restart and a
// replay, so `drainPending()` can never hand a question to the routing path after a crash.
export const ASK_PREFIX = "? ";
const MARKER = /^\?+\s*/;
export const isAsk = (text: string): boolean => MARKER.test(text);
export const stripAsk = (text: string): string => text.replace(MARKER, "").trim();
/** Idempotent: marking an already-marked question yields the same canonical string. */
export const markAsk = (text: string): string => ASK_PREFIX + stripAsk(text);
