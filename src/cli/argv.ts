/** Pure argv classification: subcommand, prose, or usage. The only place that decides whether `relay <x>` is a command or a message. */
export type ArgvPlan = { kind: "command"; cmd: string; rest: string[] } | { kind: "message"; argv: string[] } | { kind: "help" } | { kind: "unknown"; token: string };
const KNOWN = ["send", "ls", "tail", "open", "attach", "pause", "resume-all", "setup", "doctor", "db", "mcp", "--version", "-v"];   // `serve` and `hook` never reach here — src/main.ts intercepts them
const HELP = ["help", "--help"];
const VALUED = ["--to"];                                                      // flags that swallow the next token — the same one `send` reads
/** argv with flags (and their values) dropped, split on whitespace: what the user actually wrote as prose. */
export function proseWords(argv: string[]) {
  const w: string[] = [];
  for (let i = 0; i < argv.length; i++) { const t = argv[i]; if (t.startsWith("-")) { if (VALUED.includes(t)) i++; continue; } w.push(...t.split(/\s+/).filter(Boolean)); }
  return w;
}
export function planArgv(argv: string[]): ArgvPlan {
  const [cmd = "", ...rest] = argv;
  if (!cmd || HELP.includes(cmd)) return { kind: "help" };
  if (KNOWN.includes(cmd)) return { kind: "command", cmd, rest };
  // two words or more to be prose: one bare token is a mistyped subcommand far more often than a message, and guessing wrong costs a real dispatch — `relay send "<word>"` is the escape hatch
  return proseWords(argv).length >= 2 ? { kind: "message", argv } : { kind: "unknown", token: cmd };
}
/** Usage error for a token that is neither a command nor prose. */
export const unknownMessage = (token: string) => token.startsWith("-") ? `relay: unknown option "${token}"` : `relay: unknown command "${token}" — to send it as a message: relay send "${token}"`;
