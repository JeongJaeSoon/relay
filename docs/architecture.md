# Architecture

Relay is a personal, local orchestrator for native Claude Code sessions. A Bun process owns the control plane; Claude Code's supervisor owns the workers. The web dashboard, CLI, and MCP server are clients of the same HTTP, WebSocket, and event-log contracts.

This document describes the implemented architecture. The original design and implementation plans remain historical records in the project's Obsidian vault; where those plans differ from running code, the measured corrections C14-C29 and the current source take precedence.

## System boundary

```text
chat / CLI / MCP
        |
        v
HTTP gateway --> dispatcher (`claude -p`, one call per message)
        |                    |
        |                    +--> direct answer / confirmation
        v
task queue --> permit pool --> outbox --> native `claude --bg` worker
                                        in a per-task git worktree
                                               |
                                      hooks and transcript
                                               v
SQLite event log --> projections --> WebSocket frames --> dashboard
```

Relay is localhost-only and single-user. Registered project roots must be Git repositories. Workers run in Claude-managed worktrees and Relay does not use an Agent SDK as its worker runtime.

## Durable state and write path

SQLite's `events` table is the source of truth. `tasks`, `messages`, and `commands` are projections and can be rebuilt by replaying the event log. `EventLog.emit()` and `emitMany()` append events, update projections, and store any resulting WebSocket frames in one transaction; broadcasting happens only after commit.

Events carry a global sequence. Dashboard clients resume from a frame cursor, and the snapshot's `as_of_seq` is the highest sequence that produced a stored frame. A single event can produce several frames, so clients identify positions by `(seq, idx)`.

Payloads are capped and redacted before persistence. Oversized original payloads are stored separately in `blobs`; operational retention removes old details while retaining task rows and summaries.

## Dispatch and task scheduling

The gateway records and acknowledges a message before routing. The dispatcher serializes messages through one global chain and invokes `claude -p` with a JSON schema and no tools. Status questions have a code fast path. Low-confidence or destructive routing requires confirmation, and split decisions are validated as a unit before any task is created.

The scheduler grants a shared permit before a worker starts. The same pool accounts for worker subagents. A task waiting for user input releases its permit; queue order uses FIFO with an explicit queue-head override for work that must resume promptly. The global pause stops active work and prevents new spawn, resume, and send commands until resume.

Each task has a durable, per-task outbox. Commands are idempotently keyed and run in insertion order, except cleanup commands are prioritized. A command left in an uncertain state blocks later commands until a person confirms or retries it. Startup recovery completes before normal writes resume; lifecycle hooks arriving during recovery enter a durable inbox.

## Native session identity

`claude --bg --resume` forks a new session ID. Relay therefore identifies a task by its UUID and process-generation chain rather than by one session ID. `tasks.session_id` is the current binding; `process_instances` retains every generation so late hooks and cleanup can be attributed correctly.

`claude agents --json` may omit PIDs and reports launch directories rather than worker worktrees. Liveness is normalized from the roster's state and status fields. A failed roster read means unknown, never absent.

Session names and paths are not ownership proof. Relay writes `.relay-owner` in a worktree with the Relay instance, task, and session identity. A same-named session without a matching owner stamp is foreign or ambiguous: it stays visible, but Relay does not adopt, stop, or remove it automatically.

Closing a task stops every owned generation before removing any session. Removal rechecks current roster liveness because generations share a worktree. A refusal, unknown result, or surviving worktree leaves the task visible in an error state with recovery details; `closed` is recorded only after disposal is confirmed.

## Worker observation and control

Workers are launched with `--bg`, `-w`, `--agent relay-worker`, a model and effort, automatic permission mode, and per-spawn settings. Control uses Claude's native attach, stop, resume, remove, and inbox behavior.

The Claude supervisor does not inherit environment variables from the `--bg` invocation. Relay therefore writes the task UUID, generation, and per-task HMAC hook bearer as literal values in the generated settings. Lifecycle-changing hooks use the command spool so they survive a temporarily unavailable gateway; interactive permission decisions remain HTTP because replay cannot authorize a live tool call.

PreToolUse applies a fail-closed path and command guard. It confines writes to the owned worktree, blocks protected Relay and Claude configuration, and blocks push unless explicitly enabled. Hook requests also validate the task and generation. The CLI login supplies authentication; Relay removes `ANTHROPIC_API_KEY` and only passes the OAuth fallback when configured.

## Dashboard and interfaces

The dashboard is a dependency-free vanilla web bundle embedded in the compiled binary. It treats server state as authoritative, receives snapshots plus resumable WebSocket frames, and derives notifications when frames are applied so background-tab animation throttling cannot hide events.

The CLI and MCP bridge call the same server APIs. `relay attach` takes an attach lease so automated sends do not race a person in a terminal. User-facing product text is English; Korean remains supported in input-intent matching.

## Deliberate limits

The shipped system is a personal Claude Code orchestrator. Provider-neutral or Codex workers, team or multi-tenant access, remote authentication, resident Slack or GitHub assistants, and automatic push or pull-request creation are outside the implemented boundary. The enterprise and team boundary is tracked in GitHub issue [#64](https://github.com/JeongJaeSoon/relay/issues/64); it is a design issue, not shipped behavior. Changes to these boundaries require an explicit design decision and a tracked GitHub issue before implementation.

## Code map

| Area | Path |
|---|---|
| Assembly and lifecycle | `src/serve.ts`, `src/main.ts` |
| Event log and projections | `src/core/events.ts`, `src/core/projections.ts`, `src/core/replay.ts` |
| Queue, tasks, permits | `src/core/queue.ts`, `src/core/tasks.ts`, `src/core/permits.ts` |
| Dispatcher | `src/dispatcher/` |
| Native Claude adapter | `src/runner/` |
| Recovery and outbox | `src/lifecycle/` |
| Hook ingestion and guard | `src/hooks/`, `src/guard/` |
| HTTP and WebSocket | `src/gateway/` |
| Dashboard | `web/` |
| CLI and MCP | `src/cli/`, `src/mcp/` |
