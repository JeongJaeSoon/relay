import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// Getters, not constants: `RELAY_HOME` is read at access time so tests (one process, shared module cache) and `relay setup` can redirect it.
export const paths = {
  get home() { return process.env.RELAY_HOME ?? join(homedir(), ".config", "relay"); },
  get config() { return join(this.home, "config.toml"); }, get db() { return join(this.home, "relay.db"); },
  get apiToken() { return join(this.home, "api-token"); }, get hookToken() { return join(this.home, "hook-token"); }, get oauthToken() { return join(this.home, "token"); },
  get spool() { return join(this.home, "hook-spool"); }, get capabilities() { return join(this.home, "capabilities.json"); },
  get serviceFailed() { return join(this.home, "service-failed"); },
  get logDir() { return process.env.RELAY_LOG_DIR ?? join(homedir(), "Library", "Logs", "relay"); },
  get agentsDir() { return join(homedir(), ".claude", "agents"); },
};
export const ensureDirs = () => { for (const d of [paths.home, paths.spool, paths.logDir]) mkdirSync(d, { recursive: true, mode: 0o700 }); };

const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const ConfigSchema = z.object({
  port: z.number().int().min(1024).max(65535).default(8790),
  claude_bin: z.string().default("claude"),                      // absolute path written by `relay setup` (launchd PATH independence)
  path_prepend: z.array(z.string()).default([]),                 // dirs `relay setup` found `claude`/`node` in — prepended to PATH under launchd
  max_concurrent_agents: z.number().int().min(1).default(10),
  dispatcher: z.object({
    model: z.string().default("claude-fable-5"), effort: Effort.default("medium"), retry_effort: Effort.default("high"),
    timeout_ms: z.number().int().default(60_000), rate_per_min: z.number().int().default(10),
  }).prefault({}),   // REVIEW PATCH #3: zod4 .default({}) skips inner defaults
  worker: z.object({
    model: z.string().default("claude-opus-5"),
    effort: z.object({ small: Effort.default("high"), normal: Effort.default("xhigh"), epic: Effort.default("xhigh") }).prefault({}),   // REVIEW PATCH #3: zod4 .default({}) skips inner defaults
    advisor: z.string().nullable().default("claude-fable-5"),
    advisor_for: z.array(z.enum(["small", "normal", "epic"])).default(["epic"]),
    permission_mode: z.enum(["auto", "acceptEdits", "manual", "dontAsk", "bypassPermissions"]).default("auto"),
    allow_push: z.boolean().default(false),
  }).prefault({}),   // REVIEW PATCH #3: zod4 .default({}) skips inner defaults
  usage: z.object({
    daily_ceiling_tokens: z.number().int().nullable().default(null),
    wall_clock_min: z.object({ small: z.number().default(20), normal: z.number().default(120), epic: z.number().default(480) }).prefault({}),   // REVIEW PATCH #3: zod4 .default({}) skips inner defaults
    max_tool_calls_per_turn: z.number().int().default(400),
  }).prefault({}),   // REVIEW PATCH #3: zod4 .default({}) skips inner defaults
  idle: z.object({ stop_after_min: z.number().default(15), close_after_hours: z.number().default(72) }).prefault({}),   // REVIEW PATCH #3: zod4 .default({}) skips inner defaults
  pool: z.object({ subagent_parallel_per_task: z.number().int().nullable().default(null) }).prefault({}),   // REVIEW PATCH #3: zod4 .default({}) skips inner defaults
});
export type Config = z.infer<typeof ConfigSchema>;

export function parseConfig(toml: string): Config {
  const raw = toml.trim() ? (Bun.TOML.parse(toml) as Record<string, unknown>) : {};
  return ConfigSchema.parse(raw);
}
export function loadConfig(path = paths.config): Config {
  return parseConfig(existsSync(path) ? readFileSync(path, "utf8") : "");
}
