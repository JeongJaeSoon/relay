// shared/types.ts — canonical domain types shared by server, CLI and dashboard.
export type TaskStatus =
  | "queued" | "starting" | "running" | "waiting_input"
  | "done" | "needs_review" | "error" | "cancelled" | "closed";
export type ProcessState = "none" | "starting" | "alive" | "stopped" | "crashed";
export type TurnState = "idle" | "busy";
export type AttachState = "none" | "leased" | "attached";
export type TaskSize = "small" | "normal" | "epic";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type DeliveryMethod = "socket" | "resume";   // no print fallback: a worker is always a supervisor-owned `claude --bg` session (roadmap C9)
export type SendOutcome = "accepted" | "held" | "refused" | "unknown";

export interface Project {
  id: string; name: string; path: string; description: string;
  keywords: string[]; base_ref: "fresh" | "head"; is_git: boolean; created_at: number;
}

export interface TaskQuestion {
  text: string; options: string[]; asked_at: number;
  source: "marker" | "permission"; permission_tool_use_id?: string;
}

export interface Task {
  uuid: string; num: number; display_id: string;            // display_id = "T-08" (표시 전용)
  project_id: string; title: string; status: TaskStatus;
  size: TaskSize; effort: Effort; model: string;
  session_id: string | null; short_id: string | null;       // Claude session UUID / `claude agents` short id
  worktree_path: string | null; branch: string | null; base_sha: string | null;
  process_state: ProcessState; process_generation: number;
  turn_state: TurnState; attach_state: AttachState; attached_by: string | null;
  paused: boolean;                                          // kill switch가 정지시킨 실행 중 태스크
  last_summary: string | null; last_step: string | null;    // last_step = 노드 라이브 캡션(최근 도구명·요약)
  question: TaskQuestion | null;
  parent_uuid: string | null; agent_id: string | null; agent_type: string | null; // 서브에이전트 의사 태스크
  queued_at: number | null; qhead: boolean;
  started_at: number | null; ended_at: number | null;
  created_at: number; updated_at: number; closed_at: number | null;
  usage_tokens: number;                                     // transcript 합산 추정치
  cleanup_pending?: boolean;                              // derived from outstanding cleanup commands; never stored on tasks
  summary_json: TaskSummary | null;                         // 보존 정리(90일) 후 남는 요약(04 retention)
}
export interface TaskSummary { v: 1; status: TaskStatus; usage_tokens: number; events: number; commands: Record<string, number>; last_summary: string | null; digest: string; swept_at: number }

export type MessageRole = "user" | "system" | "worker_summary" | "dispatcher_answer" | "question" | "error";
export type MessageSource = "user" | "cli" | "mcp" | "github" | "slack" | "cron";
export type DispatchState = "pending" | "deciding" | "dispatched" | "fastpath" | "needs_confirm" | "failed" | "direct";

/** One piece of a `split` decision: task creation only — no nesting, no answer_directly/close_task. */
export interface DispatchItem {
  action: "new_task" | "route_to_task";
  task_id?: string; project?: string; title?: string; size?: TaskSize;
  prompt?: string; confidence?: "high" | "low";                // absent = the message's own confidence
}

export interface DispatchDecision {
  action: "new_task" | "route_to_task" | "answer_directly" | "close_task" | "split";
  task_id?: string; project?: string; title?: string; size?: TaskSize;
  prompt?: string; answer?: string; confidence: "high" | "low";
  items?: DispatchItem[];                                      // split only, from the model
  task_ids?: string[];                                         // split only, filled in by relay: every task the split produced, in item order (messages.task_uuid holds just the first)
}

export interface Message {
  id: string; role: MessageRole; source: MessageSource;
  client_message_id: string | null; dispatch_state: DispatchState;
  text: string; task_uuid: string | null; reply_to_task_uuid: string | null;
  ask: boolean;                                            // Ask mode, declared at submission — never inferred from the text (shared/ask.ts)
  dispatch_json: DispatchDecision | null; dispatch_error: string | null;
  chain_prev_id: string | null;                            // 직전 판단 메시지(문맥 체인, B6)
  created_at: number;
}

export interface EventEnvelope {
  v: 1;                                                     // envelope schema version (upcasters live in projections.ts)
  seq: number; event_id: string; type: string; task_uuid: string | null;
  source_session_id: string | null; source_event_id: string | null;
  process_generation: number | null; turn_id: string | null; tool_use_id: string | null;
  causation_id: string | null; occurred_at: number; recorded_at: number;
  payload: unknown; truncated: boolean; blob_id: string | null;   // blob_id → blobs table row holding the full (redacted) payload when truncated
}

export type CommandKind = "spawn" | "send" | "stop" | "resume" | "rm";
export type CommandState = "pending" | "running" | "applied" | "failed" | "unknown";
export interface Command {
  id: string; task_uuid: string; kind: CommandKind; payload: unknown;
  state: CommandState; attempts: number; created_at: number; applied_at: number | null; error: string | null;
}

/** A Claude session running on this machine that relay did not start. Poll-derived and read-only: relay watches it,
 *  never dispatches to it, never gives it a permit and never reaps it. `busy` is null when the roster says nothing. */
export interface ForeignSession {
  session_id: string; short_id: string | null; name: string | null; cwd: string | null; busy: boolean | null;
  pid: number | null; started_at: number | null; kind: string | null;   // from the session registry (~/.claude/sessions), the only place these exist for a foreign session
  first_seen: number; last_seen: number;                                // when relay's poll first/last saw it — not when the session began
}

export interface SystemState {
  paused: boolean; recovering: boolean; max_concurrent_agents: number;
  running: number; queued: number; leases: number;
  today_tokens: number; daily_ceiling: number | null; delivery_method: DeliveryMethod;
  version: string; log_dir: string; oauth_fallback: boolean;   // operational info (bottom of the settings panel): log location, service-auth fallback
  cli_drift: string;   // "" when the CLI matches what capabilities.json was probed against, else "<probed> → <current>"
}

// One event can produce several frames; they share `seq` and are numbered by `idx`. The client cursor is (seq, idx).
export type WsFrame =
  | { seq: number; idx: number; type: "hello"; as_of_seq: number; state: SystemState }
  | { seq: number; idx: number; type: "chat.message"; message: Message }
  | { seq: number; idx: number; type: "dispatch.updated"; message: Message }
  | { seq: number; idx: number; type: "task.created"; task: Task }
  | { seq: number; idx: number; type: "task.updated"; task: Task }
  | { seq: number; idx: number; type: "task.event"; task_uuid: string; event: EventEnvelope }
  | { seq: number; idx: number; type: "system.state"; state: SystemState }
  | { seq: number; idx: number; type: "projects.updated"; projects: Project[] }
  // Poll-derived, so it belongs to no event and carries no usable cursor: the client applies it without touching (seq, idx).
  | { seq: number; idx: number; type: "foreign.sessions"; sessions: ForeignSession[] };

export interface TasksSnapshot { as_of_seq: number; tasks: Task[]; projects: Project[]; state: SystemState; messages: Message[]; foreign: ForeignSession[] }
