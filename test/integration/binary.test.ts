import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const BIN = process.env.RELAY_BINARY ?? "dist/relay-0.1.0-darwin-arm64/relay"; const on = !!process.env.RELAY_BINARY_TEST;
const sh = async (args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) => { const p = Bun.spawn([BIN, ...args], { stdin: opts.stdin ? new Response(opts.stdin) : undefined, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...opts.env } }); return { code: await p.exited, out: await new Response(p.stdout).text() }; };
test.skipIf(!on)("binary: --version is stamped, serve answers GET / with the token meta, hook guard fails closed", async () => {
  expect((await sh(["--version"])).out).toMatch(/^relay \d+\.\d+\.\d+/);
  const home = mkdtempSync(join(tmpdir(), "relay-bin-")); writeFileSync(join(home, "config.toml"), "port = 8896\n");
  const srv = Bun.spawn([BIN, "serve"], { env: { ...process.env, RELAY_HOME: home }, stdout: "ignore", stderr: "pipe" });
  try { let html = ""; for (let i = 0; i < 40 && !html; i++) { await Bun.sleep(250); html = await fetch("http://127.0.0.1:8896/", { headers: { host: "127.0.0.1:8896" } }).then((r) => (r.ok ? r.text() : "")).catch(() => ""); }
    expect(html).toContain('name="relay-token"'); expect(html).toContain(readFileSync(join(home, "api-token"), "utf8").trim()); }
  finally { srv.kill(); await srv.exited; }
  expect((await sh(["hook", "guard"], { stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command: "sudo x" }, cwd: "/tmp" }) })).code).toBe(2);
});
