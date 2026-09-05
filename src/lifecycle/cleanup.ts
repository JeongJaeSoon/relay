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
