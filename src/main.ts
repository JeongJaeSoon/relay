import { runCommandHook } from "./hooks/command-hook.ts";
import { runGuard } from "./guard/pretooluse.ts";
const [cmd = "help", ...rest] = process.argv.slice(2);   // bare `relay` prints help: booting a server (and provisioning ~/.config/relay) is not what someone typing the bare name asked for
if (cmd === "serve") { const { serve } = await import("./serve.ts"); await serve(); }
else if (cmd === "hook") { rest[0] === "guard" ? await runGuard(rest.slice(1)) : await runCommandHook(rest[0] ?? "Unknown", rest.slice(1)); }
else { const { runCli } = await import("./cli/index.ts"); await runCli(cmd, rest); }   // plan 04 fills src/cli/index.ts; plan 02 ships a stub
