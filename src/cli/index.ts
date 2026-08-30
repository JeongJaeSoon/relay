import { CliError, RelayDown, RelayHttpError } from "./client.ts";
const USAGE = `relay — 개인용 Claude Code 오케스트레이터

  relay serve                 서버 실행(launchd가 사용)
  relay send "<msg>" [--to T-08]
  relay ls [--all] [--json]
  relay tail <T-08>
  relay open
  relay attach <T-08> [--print-only]
  relay pause | resume-all
  relay setup [--yes] [--service] | doctor [--service] [--probe] [--json]
  relay db backup [file] | restore <file> | sweep | rebuild
  relay mcp                   MCP 브리지(stdio)
  relay hook <event>|guard    세션 훅 진입점
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
  const s = await import("./simple.ts");
  switch (cmd) {
    case "send": return s.send(rest); case "ls": return s.ls(rest); case "tail": return s.tail(rest); case "open": return s.open(); case "pause": return s.pause(); case "resume-all": return s.resumeAll();
    case "attach": return (await import("./attach.ts")).attach(rest);
    case "mcp": return (await import("../mcp/server.ts")).startMcp();
    case "--version": case "-v": process.stdout.write(`relay ${process.env.RELAY_VERSION ?? "dev"}\n`); return;   // stamped by `bun build --define process.env.RELAY_VERSION=…`
    default: process.stdout.write(USAGE); if (cmd !== "help" && cmd !== "--help") throw new CliError("", 2);
  }
}
