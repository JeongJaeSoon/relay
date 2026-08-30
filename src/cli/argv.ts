/** Pure argv classification: subcommand, prose, or usage. The only place that decides whether `relay <x>` is a command or a message. */
export type ArgvPlan = { kind: "command"; cmd: string; rest: string[] } | { kind: "message"; argv: string[] } | { kind: "help" } | { kind: "usage"; reason: string };
export const KNOWN = ["send", "ls", "tail", "open", "attach", "pause", "resume-all", "setup", "doctor", "db", "mcp", "--version", "-v"];   // `serve` and `hook` never reach here — src/main.ts intercepts them
const HELP = ["help", "--help"];
const FLAGS_ONLY = ["ls", "open", "pause", "resume-all", "setup", "doctor", "mcp", "help", "--help", "--version", "-v"];   // a positional after one of these is prose the user meant to send, never an argument
const VALUED = ["--to"];                                                      // flags that swallow the next token — the same one `send` reads
/** Every subcommand is ASCII kebab-case. A token of that shape is a command or a typo of one; a token of any other shape cannot be either. */
const COMMAND_SHAPED = /^[A-Za-z][A-Za-z-]*$/;
function split(argv: string[]) {
  const pos: string[] = [], flags: string[] = [];
  for (let i = 0; i < argv.length; i++) { const t = argv[i]; if (!t.startsWith("-")) { pos.push(t); continue; } flags.push(t); if (VALUED.includes(t) && argv[i + 1] !== undefined) flags.push(argv[++i]); }
  return { pos, flags };
}
/** The command line that would have sent this argv as a message — quoted, with the flags kept, so it can be pasted as-is. */
const sendHint = (argv: string[]) => { const { pos, flags } = split(argv); return `relay send "${pos.join(" ").replace(/"/g, '\\"')}"${flags.map((f) => " " + f).join("")}`; };
export function planArgv(argv: string[]): ArgvPlan {
  const [cmd = "", ...rest] = argv;
  if (!cmd) return { kind: "help" };
  const { pos } = split(argv);
  if (HELP.includes(cmd) || KNOWN.includes(cmd)) {
    // a known command carrying prose it cannot take is a message that would silently run a side effect instead — `relay pause the login task` used to trip the kill switch
    if (FLAGS_ONLY.includes(cmd) && pos.length > (cmd.startsWith("-") ? 0 : 1)) return { kind: "usage", reason: `relay: ${cmd} takes no arguments — to send this as a message: ${sendHint(argv)}` };
    return HELP.includes(cmd) ? { kind: "help" } : { kind: "command", cmd, rest };
  }
  const head = pos[0];
  if (head === undefined) return { kind: "usage", reason: `relay: unknown option "${cmd}"` };
  // quoted prose, or a token no subcommand could ever be (accented, CJK, punctuation, digits): safe to dispatch. A bare ASCII word is a mistyped subcommand far more often than a message — `relay tial T-08`, `relay resume all` — and guessing wrong costs a real dispatch, so it has to be quoted.
  if (/\s/.test(head) || !COMMAND_SHAPED.test(head)) return { kind: "message", argv };
  return { kind: "usage", reason: `relay: "${head}" looks like a command — to send it as a message: ${sendHint(argv)}` };
}
