import { client, has } from "./client.ts";
import { resolveTask } from "./simple.ts";
export async function attach(rest: string[]) {
  const uuid = await resolveTask(rest[0] ?? ""); const c = client();
  const { command } = await c.post(`/tasks/${uuid}/attach-lease`, { by: `cli:${process.pid}` });   // pid: the server's watchdog reclaims the lease if this process dies (kill -9)
  const release = async () => { try { await c.post(`/tasks/${uuid}/attach-lease`, {}, "DELETE"); } catch {} };
  if (has(rest, "--print-only")) { process.stdout.write(command + "\n"); await release(); return; }
  const argv = [process.env.RELAY_ATTACH_EXEC ?? c.cfg.claude_bin, ...command.split(" ").slice(1)];   // `claude attach <id>` | `claude --resume <uuid>`: no spaces inside the args; the binary path is never split
  const env = { ...process.env } as Record<string, string>; delete env.ANTHROPIC_API_KEY;
  process.stdout.write(`${command}\n(끝나면 lease가 자동 해제됩니다)\n`);
  const p = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"], env });
  // Ctrl-C reaches the whole foreground group: let claude handle it and keep the lease until the child really exits; forward SIGTERM/SIGHUP
  const ignore = () => {}; const term = () => p.kill("SIGTERM");
  process.on("SIGINT", ignore); process.on("SIGTERM", term); process.on("SIGHUP", term);
  const code = await p.exited;
  process.off("SIGINT", ignore); process.off("SIGTERM", term); process.off("SIGHUP", term);
  await release(); if (code !== 0) process.exitCode = code;
}
