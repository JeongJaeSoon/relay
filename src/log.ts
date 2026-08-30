import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./config.ts";
import { now } from "./core/clock.ts";
import { redact } from "./core/redact.ts";
type Fields = Record<string, unknown>;
const MAX_BYTES = 10 * 1024 * 1024, KEEP = 5;
/** relay.log: 0600, redacted fields, rotated at 10MB keeping 5 generations (roadmap B8). */
function rotate(file: string) {
  try { if (!existsSync(file) || statSync(file).size < MAX_BYTES) return; } catch { return; }
  try { unlinkSync(`${file}.${KEEP}`); } catch {}
  for (let i = KEEP - 1; i >= 1; i--) { try { renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch {} }
  try { renameSync(file, `${file}.1`); } catch {}
}
function write(level: "info" | "warn" | "error", msg: string, fields?: Fields) {
  const line = JSON.stringify({ t: new Date(now()).toISOString(), level, msg, ...fields }, (_k, v) => (typeof v === "string" ? redact(v) : v));   // per value: redacting the serialized line can break the JSON
  process.stderr.write(line + "\n");                                        // stderr only: stdout stays clean for `relay mcp` (stdio transport)
  if (process.env.RELAY_NO_FILE_LOG) return;
  try { mkdirSync(paths.logDir, { recursive: true, mode: 0o700 }); const f = join(paths.logDir, "relay.log"); rotate(f); appendFileSync(f, line + "\n", { mode: 0o600 }); } catch {}
}
export const log = { info: (m: string, f?: Fields) => write("info", m, f), warn: (m: string, f?: Fields) => write("warn", m, f), error: (m: string, f?: Fields) => write("error", m, f) };
