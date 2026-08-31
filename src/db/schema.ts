// DDL as an ordered list of migrations. Never edit a shipped migration; append a new one.
export const MIGRATIONS: string[] = [
  /* 1 */ `
  create table meta(key text primary key, value text not null);
  create table projects(id text primary key, name text unique not null, path text unique not null, description text not null default '',
    keywords_json text not null default '[]', base_ref text not null default 'fresh' check(base_ref in ('fresh','head')), is_git integer not null default 1, created_at integer not null);
  create table tasks(
    uuid text primary key, num integer unique not null, display_id text not null, project_id text not null references projects(id),
    title text not null, status text not null check(status in ('queued','starting','running','waiting_input','done','needs_review','error','cancelled','closed')),
    size text not null check(size in ('small','normal','epic')), effort text not null check(effort in ('low','medium','high','xhigh','max')), model text not null,
    session_id text unique, short_id text, worktree_path text, branch text, base_sha text,
    process_state text not null default 'none' check(process_state in ('none','starting','alive','stopped','crashed')),
    process_generation integer not null default 0, turn_state text not null default 'idle' check(turn_state in ('idle','busy')),
    attach_state text not null default 'none' check(attach_state in ('none','leased','attached')), attached_by text,
    paused integer not null default 0, last_summary text, last_step text, question_json text,
    parent_uuid text references tasks(uuid), agent_id text, agent_type text,
    queued_at integer, qhead integer not null default 0, started_at integer, ended_at integer,
    created_at integer not null, updated_at integer not null, closed_at integer, usage_tokens integer not null default 0, summary_json text);
  create index tasks_status on tasks(status);
  create table messages(
    id text primary key, role text not null check(role in ('user','system','worker_summary','dispatcher_answer','question','error')),
    source text not null default 'user' check(source in ('user','cli','mcp','github','slack','cron')), client_message_id text unique,
    dispatch_state text not null default 'pending' check(dispatch_state in ('pending','deciding','dispatched','fastpath','needs_confirm','failed','direct')), text text not null, task_uuid text references tasks(uuid), reply_to_task_uuid text,
    dispatch_json text, dispatch_error text, chain_prev_id text, created_at integer not null);
  create index messages_dispatch on messages(dispatch_state);
  create table events(
    seq integer primary key autoincrement, event_id text unique not null, type text not null, task_uuid text,
    source_session_id text, source_event_id text, process_generation integer, turn_id text, tool_use_id text, causation_id text,
    occurred_at integer not null, recorded_at integer not null, payload_json text not null, truncated integer not null default 0, blob_id text, v integer not null default 1,
    unique(source_session_id, process_generation, source_event_id));
  create index events_task on events(task_uuid, seq);
  create table ws_frames(seq integer primary key references events(seq), frame_json text not null);
  create table commands(id text primary key, task_uuid text not null references tasks(uuid), kind text not null check(kind in ('spawn','send','stop','resume','rm')), payload_json text not null,
    state text not null default 'pending' check(state in ('pending','running','applied','failed','unknown')), attempts integer not null default 0,
    created_at integer not null, applied_at integer, error text);
  create index commands_task on commands(task_uuid, state);
  create table process_instances(id text primary key, task_uuid text not null references tasks(uuid), short_id text, session_id text, pid integer,
    generation integer not null, started_at integer not null, ended_at integer, end_reason text);
  create table permit_leases(id text primary key, holder_kind text not null check(holder_kind in ('task','subagent')), holder_id text not null,
    task_uuid text not null references tasks(uuid), acquired_at integer not null, released_at integer, reason text);
  create index leases_active on permit_leases(released_at) where released_at is null;
  create table blobs(id text primary key, created_at integer not null, body blob not null);
  create table hook_inbox(id integer primary key autoincrement, received_at integer not null, headers_json text not null, body_json text not null);   -- durable buffer for hooks that arrive while recovering
  insert into meta(key,value) values('schema_version','1');
  `,
  /* 2 */ `
  alter table messages add column ask integer not null default 0;
  -- Ask mode used to be stored as a '? ' prefix on the text. Keep what those rows meant; the only case this cannot
  -- tell apart is the bug the column fixes — a github/slack/cron body that merely started with '? '.
  update messages set ask=1 where role='user' and text like '? %';
  `,
];
export const SCHEMA_VERSION = MIGRATIONS.length;
