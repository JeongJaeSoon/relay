import { existsSync, readFileSync } from "node:fs";
import { loadConfig, paths } from "../config.ts";
import { relayBin } from "../runner/settings.ts";
export { relayBin };                                                          // absolute path, Cellar→opt mapped, quoted when it contains spaces (02 Task 7)
/** relayBin() as argv: the hook command string is shell-quoted; Bun.spawn / `claude mcp add` want tokens. */
export const relayArgv = (): string[] => (relayBin().match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []).map((t) => (t.startsWith('"') ? JSON.parse(t) : t));
export class RelayDown extends Error { constructor() { super("relay: the server is not running — `brew services start relay` or `relay serve`"); } }
export class RelayHttpError extends Error { constructor(public status: number, body: string) { super(`relay: ${status} ${body}`); } }
export class CliError extends Error { constructor(message: string, public code = 1) { super(message); } }
export function client() {
  const cfg = loadConfig(); const base = `http://127.0.0.1:${cfg.port}`;
  const token = existsSync(paths.apiToken) ? readFileSync(paths.apiToken, "utf8").trim() : "";
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  // never process.exit here — runCli() maps RelayDown → 3, CliError → its code, RelayHttpError → 1; the MCP bridge and tests keep running
  const wrap = async (p: Promise<Response>) => { let r: Response; try { r = await p; } catch { throw new RelayDown(); } if (!r.ok) throw new RelayHttpError(r.status, await r.text()); return r.json() as Promise<any>; };
  return { base, token, cfg,
    get: (path: string) => wrap(fetch(`${base}/api${path}`, { headers })),
    post: (path: string, body: unknown = {}, method = "POST") => wrap(fetch(`${base}/api${path}`, { method, headers, body: JSON.stringify(body) })),
    up: () => fetch(`${base}/api/usage`, { headers }).then((r) => r.ok).catch(() => false),
    ws(fromSeq: number, onFrame: (f: any) => void, onClose: () => void) { const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws?from_seq=${fromSeq}&token=${encodeURIComponent(token)}`); ws.onmessage = (e) => onFrame(JSON.parse(String(e.data))); ws.onerror = () => onClose(); ws.onclose = () => onClose(); return ws; } };
}
export type RelayClient = ReturnType<typeof client>;
export const arg = (rest: string[], name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
export const has = (rest: string[], name: string) => rest.includes(name);
