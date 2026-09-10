// src/core/goals.ts — durable goal declarations and post-commit lifecycle reconciliation.
//
// Goal events are NEVER task-scoped. Retention deletes events by events.task_uuid; every goal event instead carries
// the complete task UUID snapshot in its payload so membership, cycles and notification claims survive a rebuild.
import type { Database } from "bun:sqlite";
import type { Goal, GoalCycle, GoalMember, GoalMemberState, GoalNotificationClaim, GoalOutcome, GoalRequestSnapshot, Message, TaskStatus } from "@shared/types.ts";
import type { EmitInput, EventLog } from "./events.ts";
import { commandId } from "./ids.ts";

const J = (s: string | null) => s == null ? null : JSON.parse(s);

export interface GoalMemberDeclaration {
  split_item_id: string; task_uuid: string; task_display_id: string; ordinal?: number;
}

export const goalIdFor = (messageId: string) => `goal:${messageId}`;
export const splitItemIdFor = (messageId: string, ordinal: number) => `${messageId}:${ordinal}`;
export const notificationClaimIdFor = (goalId: string, generation: number) => `${goalId}:completion:${generation}`;

export function goalCreatedInput(message: Message, declarations: GoalMemberDeclaration[], id = goalIdFor(message.id)): EmitInput {
  if (message.role !== "user") throw new Error("a goal must snapshot a user message");
  if (!declarations.length) throw new Error("a goal must have at least one member");
  const seenItems = new Set<string>(); const seenOrdinals = new Set<number>();
  const members = declarations.map((m, i) => {
    const ordinal = m.ordinal ?? i;
    if (!m.split_item_id || !m.task_uuid || !m.task_display_id) throw new Error("goal members require split item, task UUID and display id");
    if (seenItems.has(m.split_item_id)) throw new Error(`duplicate goal split item: ${m.split_item_id}`);
    if (seenOrdinals.has(ordinal)) throw new Error(`duplicate goal member ordinal: ${ordinal}`);
    seenItems.add(m.split_item_id); seenOrdinals.add(ordinal);
    return { split_item_id: m.split_item_id, ordinal, task_uuid: m.task_uuid, task_display_id: m.task_display_id };
  });
  const request: GoalRequestSnapshot = { message_id: message.id, source: message.source, client_message_id: message.client_message_id, text: message.text, ask: message.ask, created_at: message.created_at };
  return { type: "goal.created", payload: { goal_id: id, request, members, task_uuids: [...new Set(members.map((m) => m.task_uuid))] } };
}

export function rowToGoal(r: any): Goal {
  const { original_request_json, ...rest } = r;
  return { ...rest, original_request: J(original_request_json) };
}
export function rowToGoalMember(r: any): GoalMember { return r as GoalMember; }
export function rowToGoalCycle(r: any): GoalCycle {
  const { member_states_json, ...rest } = r;
  return { ...rest, member_states: J(member_states_json) };
}
export function rowToGoalNotificationClaim(r: any): GoalNotificationClaim {
  const { task_uuids_json, ...rest } = r;
  return { ...rest, task_uuids: J(task_uuids_json) ?? [] };
}
export const loadGoal = (db: Database, id: string): Goal | null => { const r = db.query("select * from goals where id=?").get(id); return r ? rowToGoal(r) : null; };
export const loadGoalMembers = (db: Database, id: string): GoalMember[] => (db.query("select * from goal_members where goal_id=? order by ordinal").all(id) as any[]).map(rowToGoalMember);
export const loadGoalCycles = (db: Database, id: string): GoalCycle[] => (db.query("select * from goal_cycles where goal_id=? order by generation").all(id) as any[]).map(rowToGoalCycle);
export const pendingGoalNotifications = (db: Database): GoalNotificationClaim[] => (db.query("select * from goal_notification_claims where state='pending' order by claimed_at, claim_id").all() as any[]).map(rowToGoalNotificationClaim);

/** Upgrade bridge for messages dispatched before goal events existed. It appends ordinary non-task-scoped
 * `goal.created` events, so the backfill survives the next projection rebuild instead of living only in tables. */
export function backfillLegacyGoals(db: Database, log: EventLog): number {
  const rows = db.query(`select * from messages m where m.role='user' and m.task_uuid is not null
    and (m.dispatch_state='dispatched' or (m.dispatch_state='direct' and m.reply_to_task_uuid is not null))
    and not exists (select 1 from goals g where g.id='goal:'||m.id) order by m.created_at,m.rowid`).all() as any[];
  let count = 0;
  for (const r of rows) {
    const dispatch = r.dispatch_json ? JSON.parse(r.dispatch_json) as { action?: string; task_ids?: string[] } : null;
    // Mirror the goal-producing decision branches exactly. A close_task message also has a target task UUID and a
    // dispatched decision, but it is cleanup authority, not new work; boot must never turn it into a goal later.
    if (r.dispatch_state === "dispatched" && !["new_task", "route_to_task", "split"].includes(dispatch?.action ?? "")) continue;
    const ids = dispatch?.action === "split" && dispatch.task_ids?.length ? dispatch.task_ids : null;
    const declarations: GoalMemberDeclaration[] = [];
    if (ids) {
      for (const [ordinal, display] of ids.entries()) {
        const task = db.query("select uuid,display_id,status from tasks where display_id=? order by num desc limit 1").get(display) as { uuid: string; display_id: string; status: TaskStatus } | null;
        if (!task || task.status === "closed") { declarations.length = 0; break; } // incomplete historical result evidence must not mint partial or permanently-active membership
        declarations.push({ split_item_id: splitItemIdFor(r.id, ordinal), task_uuid: task.uuid, task_display_id: task.display_id, ordinal });
      }
    } else {
      const task = db.query("select uuid,display_id,status from tasks where uuid=?").get(r.task_uuid) as { uuid: string; display_id: string; status: TaskStatus } | null;
      if (task && task.status !== "closed") declarations.push({ split_item_id: splitItemIdFor(r.id, 0), task_uuid: task.uuid, task_display_id: task.display_id, ordinal: 0 });
    }
    if (!declarations.length) continue;
    const message: Message = { id: r.id, role: "user", source: r.source, client_message_id: r.client_message_id, dispatch_state: r.dispatch_state, text: r.text, task_uuid: r.task_uuid, reply_to_task_uuid: r.reply_to_task_uuid,
      ask: !!r.ask, dispatch_json: dispatch as any, dispatch_error: r.dispatch_error, chain_prev_id: r.chain_prev_id, created_at: r.created_at };
    log.emit(goalCreatedInput(message, declarations)); count++;
  }
  return count;
}

type ObservedMember = GoalMember & { task_status: TaskStatus | null };
type Evaluation = { outcome: GoalOutcome; states: GoalMemberState[] } | null;

function priorTerminalStates(db: Database, goalId: string, beforeGeneration: number): Map<string, GoalMemberState["status"]> {
  const rows = db.query("select member_states_json from goal_cycles where goal_id=? and generation<? and status='completed' order by generation desc").all(goalId, beforeGeneration) as any[];
  const out = new Map<string, GoalMemberState["status"]>();
  for (const r of rows) for (const s of (J(r.member_states_json) ?? []) as GoalMemberState[]) if (!out.has(s.split_item_id)) out.set(s.split_item_id, s.status);
  return out;
}

/** Evaluate one active generation. `closed` is cleanup, not a work result: it only inherits a terminal result proven
 * by an earlier completed generation. An initially closed/missing member therefore blocks completion rather than
 * being silently treated as success. needs_review/error/waiting/active states all block. */
export function evaluateGoal(db: Database, goalId: string): Evaluation {
  const goal = loadGoal(db, goalId); if (!goal) throw new Error(`goal ${goalId} not found`);
  const prior = priorTerminalStates(db, goalId, goal.current_generation);
  const rows = db.query(`select gm.*, t.status task_status from goal_members gm left join tasks t on t.uuid=gm.task_uuid where gm.goal_id=? order by gm.ordinal`).all(goalId) as ObservedMember[];
  if (!rows.length) throw new Error(`goal ${goalId} has no members`);
  const states: GoalMemberState[] = [];
  for (const r of rows) {
    const status = r.task_status === "done" || r.task_status === "cancelled" ? r.task_status : r.task_status === "closed" ? prior.get(r.split_item_id) : undefined;
    if (!status) return null;
    states.push({ split_item_id: r.split_item_id, task_uuid: r.task_uuid, task_display_id: r.task_display_id, status });
  }
  const cancelled = states.filter((s) => s.status === "cancelled").length;
  return { states, outcome: cancelled === 0 ? "completed" : cancelled === states.length ? "cancelled" : "completed_with_cancellations" };
}

function taskUuids(db: Database, goalId: string): string[] {
  return (db.query("select distinct task_uuid from goal_members where goal_id=? order by task_uuid").all(goalId) as any[]).map((r) => r.task_uuid);
}

export function reopenGoalInput(db: Database, goalId: string): EmitInput {
  const goal = loadGoal(db, goalId); if (!goal) throw new Error(`goal ${goalId} not found`);
  if (goal.status !== "completed") throw new Error(`goal ${goalId} is not completed`);
  return { type: "goal.reopened", payload: { goal_id: goalId, generation: goal.current_generation + 1, task_uuids: taskUuids(db, goalId) } };
}

export function goalReviewedInput(db: Database, goalId: string): EmitInput {
  const goal = loadGoal(db, goalId); if (!goal) throw new Error(`goal ${goalId} not found`);
  if (goal.status !== "completed") throw new Error(`goal ${goalId} is not completed`);
  return { type: "goal.reviewed", payload: { goal_id: goalId, generation: goal.current_generation, task_uuids: taskUuids(db, goalId) } };
}

/** Retry targets only the latest completed goal cycle in which this task was actually cancelled. A fresh user route
 * always creates a new goal and must never reopen historical goals merely because it reuses their worker task. */
export function reopenLatestCompletedGoalForTask(db: Database, taskUuid: string): EmitInput | null {
  const rows = db.query(`select g.id,g.current_generation,gc.member_states_json from goals g join goal_members gm on gm.goal_id=g.id join goal_cycles gc on gc.goal_id=g.id and gc.generation=g.current_generation where gm.task_uuid=? and g.status='completed' order by g.completed_at desc,g.id desc`).all(taskUuid) as any[];
  for (const r of rows) {
    const states = (J(r.member_states_json) ?? []) as GoalMemberState[];
    if (states.some((s) => s.task_uuid === taskUuid && s.status === "cancelled")) return reopenGoalInput(db, r.id);
  }
  return null;
}

function completionStopInputs(db: Database, goalId: string, generation: number): EmitInput[] {
  const rows = db.query(`select distinct t.uuid,t.process_generation,t.session_id from goal_members gm join tasks t on t.uuid=gm.task_uuid
    where gm.goal_id=? and t.process_state in ('alive','starting') and t.session_id is not null and not exists (
      select 1 from goal_members other_m join goals other_g on other_g.id=other_m.goal_id
      where other_m.task_uuid=t.uuid and other_g.status='active' and other_g.id<>?)
    and not exists (select 1 from commands c where c.task_uuid=t.uuid and c.kind='stop' and c.state in ('pending','running')) order by t.uuid`).all(goalId, goalId) as any[];
  return rows.map((t) => {
    const id = commandId("stop", `goal:${goalId}:${generation}:${t.uuid}:${t.process_generation}`);
    const payload = { kind: "stop", reason: "goal completed", expected: { goal_id: goalId, generation, process_generation: t.process_generation, session_id: t.session_id ?? null } };
    return { type: "command.queued", task_uuid: t.uuid, causation_id: id, payload: { id, kind: "stop", payload } };
  });
}

export type GoalReconcileResult = { goal_id: string; action: "none" | "completed"; generation: number; outcome?: GoalOutcome; claim_id?: string; stop_command_ids?: string[] };

/** Reconcile only AFTER the task event's EventLog transaction has committed. It reads committed task projections and
 * appends a separate goal event; applyProjection intentionally never calls this function or emits nested events. */
export function reconcileGoal(db: Database, log: EventLog, goalId: string): GoalReconcileResult {
  const goal = loadGoal(db, goalId); if (!goal) throw new Error(`goal ${goalId} not found`);
  const uuids = taskUuids(db, goalId);
  if (goal.status === "completed") return { goal_id: goalId, action: "none", generation: goal.current_generation };
  const result = evaluateGoal(db, goalId);
  if (!result) return { goal_id: goalId, action: "none", generation: goal.current_generation };
  const claim_id = notificationClaimIdFor(goalId, goal.current_generation);
  const completion: EmitInput = { type: "goal.completed", payload: { goal_id: goalId, generation: goal.current_generation, outcome: result.outcome, member_states: result.states, task_uuids: uuids, notification_claim_id: claim_id, review_after_ms: log.cfg.idle.close_after_hours * 60 * 60 * 1000 } };
  const stops = completionStopInputs(db, goalId, goal.current_generation);
  log.emitMany([completion, ...stops]); // claim and eligible, generation-bound stop intents commit or roll back together
  return { goal_id: goalId, action: "completed", generation: goal.current_generation, outcome: result.outcome, claim_id, stop_command_ids: stops.map((s: any) => s.payload.id) };
}

export function reconcileGoalsForTask(db: Database, log: EventLog, taskUuid: string): GoalReconcileResult[] {
  const ids = (db.query("select distinct goal_id from goal_members where task_uuid=? order by goal_id").all(taskUuid) as any[]).map((r) => r.goal_id);
  return ids.map((id) => reconcileGoal(db, log, id));
}

export function reconcileAllGoals(db: Database, log: EventLog): GoalReconcileResult[] {
  const ids = (db.query("select id from goals order by id").all() as any[]).map((r) => r.id);
  return ids.map((id) => reconcileGoal(db, log, id));
}

/** Records that the dashboard handled the claim. This is not proof that an operating-system notification displayed. */
export function goalNotificationDeliveredInput(claim: GoalNotificationClaim): EmitInput {
  return { type: "goal.notification_delivered", payload: { claim_id: claim.claim_id, goal_id: claim.goal_id, generation: claim.generation, task_uuids: claim.task_uuids } };
}
