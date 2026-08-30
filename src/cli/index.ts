// src/cli/index.ts — placeholder until plan 04 wires the real subcommands.
export async function runCli(cmd: string, _rest: string[]) {
  console.error(`relay: unknown command "${cmd}" (CLI subcommands arrive with plan 04)\nusage: relay [serve|hook <event>|hook guard]`);
  process.exit(2);
}
