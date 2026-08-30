# Changelog

## 0.1.0

First release.

### Orchestrator

- One-shot dispatcher (`claude -p`, strictly serialized): `new_task` / `route_to_task` /
  `answer_directly` / `close_task`, with a status-query fast path answered from the snapshot.
- Workers are native `claude --bg` sessions in git worktrees, spawned with `--agent relay-worker`;
  observation is per-session hooks injected through `--settings`, control is `claude
  stop / attach / --resume`.
- Append-only SQLite event log as the single source of truth, with projections
  (`tasks`/`messages`/`commands`/`permit_leases`) and WS frames written in the same transaction.
- Permit pool, FIFO scheduler (concurrency 1 for non-git projects), outbox with per-task serial
  execution, startup recovery barrier, idle reaper, usage guard, process watchdog, kill switch.
- Fail-closed `PreToolUse` guard (realpath worktree boundary, `sudo`, `rm -rf /`, credential
  paths, `git push` opt-in) and a `PermissionRequest` policy that promotes `ask` to the dashboard.

### Dashboard

- Single inlined HTML page served on loopback with the API token in a meta tag; task graph, chat
  timeline, task detail, settings, notifications. WS resume from `from_seq`.

### CLI, MCP, packaging

- `relay send / ls / tail / open / attach / pause / resume-all`, Korean output, `--json` for
  scripts. `attach` brackets `claude attach|--resume` with the server-side attach lease.
- `relay mcp`: stdio bridge exposing `relay_send` / `relay_list` / `relay_status`; a dead relay
  becomes an `isError` result so the bridge stays alive.
- `relay setup`: claude discovery and version/login check, launchd service-context auth probe with
  an OAuth token fallback, config, project registration, agent definitions, MCP registration,
  capability probe.
- `relay doctor [--service] [--probe] [--json]`: the full check list, re-runnable inside a
  throw-away launchd agent.
- `relay db backup | restore | sweep | rebuild` plus a daily 90-day retention sweep with a monthly
  VACUUM.
- Single `bun build --compile` binary (~59 MB arm64) with the dashboard and `agents/*.md`
  embedded, a Homebrew formula with a launchd service block, and a build-only release script.

### Measured deviations from the design

- `claude --bg` sessions do not inherit the environment of the invoking process (the supervisor
  daemon owns them), so hook headers and hook command arguments are baked in as literal values per
  spawn instead of `$RELAY_*` references.
- `--advisor` does not exist in CLI 2.1.251: the advisor decision is recorded but not passed.
- `WorktreeCreate` / `WorktreeRemove` are provider hooks, not observation hooks, and are not
  registered.
- `claude rm` refusing to remove a session whose worktree holds uncommitted or unpushed work is
  expected, not an error.
