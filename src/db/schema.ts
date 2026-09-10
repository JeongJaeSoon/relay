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
  -- The same rule lives as an upcaster in projections.ts (message.received), so a projection rebuild lands here
  -- too; a backfill without one is undone by the next replay. See the note at the top of replay.ts.
  update messages set ask=1 where role='user' and text like '? %';
  `,
  /* 3 */ `
  -- Goals are event-sourced, durable user-request lifetimes. They deliberately do not own tasks and goal_members
  -- deliberately has no FK to tasks: retention may remove a closed task's task-scoped history, while the goal and
  -- its immutable membership must remain replayable from the non-task-scoped goal events.
  create table goals(
    id text primary key, request_message_id text not null, original_request_json text not null,
    status text not null check(status in ('active','completed')), current_generation integer not null check(current_generation > 0),
    outcome text check(outcome in ('completed','completed_with_cancellations','cancelled')),
    created_at integer not null, updated_at integer not null, completed_at integer, review_due_at integer, reviewed_at integer);
  create table goal_members(
    goal_id text not null references goals(id), split_item_id text not null, ordinal integer not null check(ordinal >= 0),
    task_uuid text not null, task_display_id text not null, created_at integer not null,
    primary key(goal_id, split_item_id), unique(goal_id, ordinal));
  create index goal_members_task on goal_members(task_uuid, goal_id);
  create table goal_cycles(
    goal_id text not null references goals(id), generation integer not null check(generation > 0),
    status text not null check(status in ('active','completed')),
    outcome text check(outcome in ('completed','completed_with_cancellations','cancelled')),
    opened_at integer not null, completed_at integer, member_states_json text,
    primary key(goal_id, generation));
  create table goal_notification_claims(
    claim_id text primary key, goal_id text not null, generation integer not null,
    outcome text not null check(outcome in ('completed','completed_with_cancellations','cancelled')),
    task_uuids_json text not null, state text not null default 'pending' check(state in ('pending','delivered','reviewed','superseded')),
    claimed_at integer not null, delivered_at integer, resolved_at integer, completion_event_id text not null,
    unique(goal_id, generation), foreign key(goal_id, generation) references goal_cycles(goal_id, generation));
  create index goal_claims_pending on goal_notification_claims(state, claimed_at);
  `,
];
export const SCHEMA_VERSION = MIGRATIONS.length;
