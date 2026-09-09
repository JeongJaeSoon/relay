import type { Database } from "bun:sqlite";

/** Includes superseded generations and in-flight cleanup: a successful older rm cannot hide a newer failure. */
export const pendingCleanup = (db: Database, taskUuid: string | null = null) => db.query(`select c.id, c.kind, c.state, c.error, t.display_id, t.worktree_path,
  coalesce(json_extract(c.payload_json,'$.target.session_id'),t.session_id) session_id
  from commands c join tasks t on t.uuid=c.task_uuid
  where (? is null or c.task_uuid=?) and c.kind in ('stop','rm') and c.state in ('pending','running','unknown','failed')
  and (c.kind='stop' or not exists (select 1 from commands newer where newer.task_uuid=c.task_uuid and newer.kind=c.kind
    and newer.rowid>c.rowid and newer.state='applied'
    and json_extract(newer.payload_json,'$.target.session_id') is json_extract(c.payload_json,'$.target.session_id')))
  order by c.rowid`).all(taskUuid, taskUuid) as { id: string; kind: string; state: string; error: string | null; display_id: string; worktree_path: string | null; session_id: string | null }[];

/** A task-level rm is the durable close transaction. Interrupt also queues a stop, so generic cleanup_pending cannot
 * distinguish "safe to continue after the stop" from "this task is being disposed". */
export const closePending = (db: Database, taskUuid: string): boolean => !!db.query(`select 1 from commands
  where task_uuid=? and kind='rm' and json_extract(payload_json,'$.target') is null
  and state in ('pending','running','unknown','failed') limit 1`).get(taskUuid);
