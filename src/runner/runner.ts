import type { Effort, SendOutcome } from "@shared/types.ts";

export interface SpawnSpec { taskUuid: string; displayId: string; name: string; cwd: string; worktree: string | null; model: string; effort: Effort; permissionMode: string; advisor: string | null; agent: string; settingsJson: string; prompt: string; env: Record<string, string> }
export interface AgentRow { short_id: string | null; session_id: string | null; name: string | null; cwd: string | null; pid: number | null; alive: boolean; busy: boolean | null; waiting_for: string | null; raw: unknown }
export interface AgentRunner {
  spawn(spec: SpawnSpec): Promise<{ short_id: string; name: string }>;
  resume(p: { sessionId: string; cwd: string; name: string; settingsJson: string; prompt: string; env: Record<string, string> }): Promise<{ short_id: string }>;
  stop(shortId: string): Promise<void>;
  rm(shortId: string): Promise<{ worktreeKept: boolean }>;
  list(all?: boolean): Promise<AgentRow[]>;
  sendSocket?(socketPath: string, text: string, msgId: string): Promise<SendOutcome>;   // Task 17
}
