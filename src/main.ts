import { runCommandHook } from "./hooks/command-hook.ts";
import { runGuard } from "./guard/pretooluse.ts";
const [cmd = "serve", ...rest] = process.argv.slice(2);
if (cmd === "serve") { const { serve } = await import("./serve.ts"); await serve(); }
else if (cmd === "hook") { rest[0] === "guard" ? await runGuard(rest.slice(1)) : await runCommandHook(rest[0] ?? "Unknown", rest.slice(1)); }
else { const { runCli } = await import("./cli/index.ts"); await runCli(cmd, rest); }   // plan 04 fills src/cli/index.ts; plan 02 ships a stub
