// shared/ask.ts — the `?` gesture, shared by the gateway, the dashboard and the CLI.
// A question is declared at submission: the `ask` field on POST /api/messages, or the `?` a person typed at the
// composer or the CLI. The gateway resolves both into `messages.ask` and stores the question without the prefix —
// the intent travels as data, so no layer downstream can mistake a body that merely starts with `?` for a question.
const MARKER = /^\?+\s*/;
export const isAsk = (text: string): boolean => MARKER.test(text);
export const stripAsk = (text: string): string => text.replace(MARKER, "").trim();
