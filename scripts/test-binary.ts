import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const root = join(import.meta.dir, "..");

async function command(argv: string[], options: { cwd?: string; env?: Record<string, string>; stdin?: string } = {}) {
  const child = Bun.spawn(argv, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdin: options.stdin === undefined ? "ignore" : new Response(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

async function availablePort() {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => reservation.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a loopback port");
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

export async function stopChild(child: ReturnType<typeof Bun.spawn>, forceAfterMs = 2_000) {
  if (child.exitCode !== null) return child.exitCode;
  child.kill("SIGTERM");
  const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, forceAfterMs);
  try { return await child.exited; } finally { clearTimeout(force); }
}

export function binaryServerEnv(scratch: string, ambient: Record<string, string | undefined> = process.env): Record<string, string> {
  return {
    HOME: scratch,
    PATH: ambient.PATH ?? "/usr/bin:/bin",
    TMPDIR: scratch,
    RELAY_HOME: scratch,
    RELAY_LOG_DIR: scratch,
    RELAY_NO_FILE_LOG: "1",
  };
}

export async function runBinarySmoke(ambient: Record<string, string | undefined> = process.env) {
  const scratch = mkdtempSync(join(tmpdir(), "relay-binary-smoke-"));
  const fakeClaude = join(scratch, "fake-claude");
  const binary = join(scratch, "relay");
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
  let server: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await Bun.write(fakeClaude, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' '2.1.251'; exit 0; fi
if [ "$1" = "agents" ] && [ "$2" = "--json" ]; then printf '%s\\n' '[]'; exit 0; fi
printf '%s\\n' "unsupported fake claude invocation: $*" >&2
exit 64
`);
    chmodSync(fakeClaude, 0o755);
    const web = await command(["bun", "run", "build:web"]);
    if (web.exitCode !== 0) throw new Error(`web build failed:\n${web.stderr || web.stdout}`);
    const build = await command(["bun", "build", "--compile", "--minify", "--target=bun", "--define", `process.env.RELAY_VERSION=${JSON.stringify(version)}`, "src/main.ts", "--outfile", binary]);
    if (build.exitCode !== 0) throw new Error(`binary build failed:\n${build.stderr || build.stdout}`);

    const env = binaryServerEnv(scratch, ambient);
    const stamped = await command([binary, "--version"], { cwd: scratch, env });
    if (stamped.exitCode !== 0 || stamped.stdout.trim() !== `relay ${version}`) throw new Error(`unexpected binary version: ${stamped.stdout.trim()} (${stamped.exitCode})`);

    let html = "";
    for (let launch = 0; launch < 5 && !html; launch++) {
      const port = await availablePort();
      await Bun.write(join(scratch, "config.toml"), `port = ${port}\nclaude_bin = ${JSON.stringify(fakeClaude)}\n`);
      server = Bun.spawn([binary, "serve"], { cwd: scratch, env, stdout: "ignore", stderr: "pipe" });
      const stderrPromise = new Response(server.stderr as ReadableStream<Uint8Array>).text();
      for (let attempt = 0; attempt < 80 && !html && server.exitCode === null; attempt++) {
        await Bun.sleep(50);
        html = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: `127.0.0.1:${port}` } }).then((response) => response.ok ? response.text() : "").catch(() => "");
      }
      if (html) break;
      if (server.exitCode === null) {
        await stopChild(server);
        throw new Error("compiled server stayed alive but did not become ready");
      }
      const stderr = await stderrPromise;
      server = undefined;
      if (/EADDRINUSE|address already in use|port .*in use/i.test(stderr) && launch < 4) continue;
      throw new Error(`compiled server exited before readiness:\n${stderr}`);
    }
    if (!html) throw new Error("compiled server exhausted port retries");
    const apiToken = readFileSync(join(scratch, "api-token"), "utf8").trim();
    if (!html.includes('name="relay-token"') || !html.includes(apiToken)) throw new Error("dashboard did not contain its generated API token");

    const guard = await command([binary, "hook", "guard"], { cwd: scratch, env, stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command: "sudo x" }, cwd: scratch }) });
    if (guard.exitCode !== 2) throw new Error(`hook guard unexpectedly exited ${guard.exitCode}: ${guard.stderr || guard.stdout}`);
    const lang = html.match(/<html\s+lang="([^"]+)"/)?.[1] ?? null;
    return { version: stamped.stdout.trim(), dashboardBytes: html.length, dashboardLang: lang, guardExitCode: guard.exitCode };
  } finally {
    if (server && server.exitCode === null) {
      await stopChild(server);
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await runBinarySmoke();
  console.log(`binary smoke passed: ${result.version}, dashboard ${result.dashboardBytes} bytes, guard exit ${result.guardExitCode}`);
}
