import { planArgv } from "./argv.ts";
import { CliError, RelayDown, RelayHttpError } from "./client.ts";
const USAGE = `relay — a personal Claude Code orchestrator

  relay "<msg>" [--to T-08]   send a message to the dispatcher — quote it (same as relay send)
  relay serve                 run the server (used by launchd)
  relay send "<msg>" [--to T-08]
  relay ls [--all] [--json]
  relay tail <T-08>
  relay open
  relay attach <T-08> [--print-only]
  relay pause | resume-all
  relay setup [--yes] [--service] | doctor [--service] [--probe] [--json]
  relay db backup [file] | restore <file> | sweep | rebuild
  relay mcp                   MCP bridge (stdio)
  relay hook <event>|guard    session hook entry point
`;
/** The only place that turns errors into exit codes (library code never calls process.exit). */
export async function runCli(cmd: string, rest: string[]) {
  try { await dispatch(cmd, rest); }
  catch (e) {
    if (e instanceof RelayDown) { console.error(e.message); process.exit(3); }
    if (e instanceof CliError) { if (e.message) console.error(e.message); process.exit(e.code); }
    console.error(e instanceof RelayHttpError ? e.message : `relay: ${String((e as Error)?.message ?? e)}`); process.exit(1);
  }
}
async function dispatch(cmd: string, rest: string[]) {
  const p = planArgv([cmd, ...rest]);
  if (p.kind === "help") { process.stdout.write(USAGE); return; }
  if (p.kind === "usage") { process.stdout.write(USAGE); throw new CliError(p.reason, 2); }
  const s = await import("./simple.ts");
  if (p.kind === "message") return s.send(p.argv);                            // `relay "refactor the auth module"` — no subcommand, straight to the dispatcher
  switch (p.cmd) {
    case "send": return s.send(rest); case "ls": return s.ls(rest); case "tail": return s.tail(rest); case "open": return s.open(); case "pause": return s.pause(); case "resume-all": return s.resumeAll();
    case "attach": return (await import("./attach.ts")).attach(rest);
    case "setup": return (await import("./setup.ts")).setup(rest); case "doctor": return (await import("./doctor.ts")).doctor(rest);
    case "db": return (await import("./db.ts")).db(rest);
    case "mcp": return (await import("../mcp/server.ts")).startMcp();
    case "--version": case "-v": process.stdout.write(`relay ${process.env.RELAY_VERSION ?? "dev"}\n`); return;   // stamped by `bun build --define process.env.RELAY_VERSION=…`
    default: process.stdout.write(USAGE); throw new CliError("", 2);                 // unreachable: planArgv only returns commands the cases above cover
  }
}
