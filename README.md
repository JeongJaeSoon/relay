# relay

Personal multi-agent orchestrator for Claude Code.

One message in, immediate ack: a one-shot dispatcher routes it to a new or existing task, and
workers run as native `claude --bg` sessions in git worktrees. Observation is per-session hooks,
control is `claude stop/attach/--resume`, and a SQLite event log is the single source of truth.
A graph dashboard, a chat surface, and a CLI/MCP bridge ship as one Bun binary.

## Install

```sh
brew install jeongjaesoon/tap/relay
relay setup --service          # claude check, service auth, config, projects, agents, MCP
brew services start relay
relay open                     # http://127.0.0.1:8790
```

See [docs/INSTALL.md](docs/INSTALL.md) for the service-context token fallback, updates and backups.

## Architecture

```
you ──chat/CLI/MCP──▶ dispatcher (claude -p, one shot)
                          │  new_task | route_to_task | answer_directly
                          ▼
                     task queue ──permit──▶ worker  (claude --bg -w <worktree> --agent relay-worker)
                                              │  per-session hooks (--settings, literal headers)
                                              ▼
                                     event log (SQLite, append-only)
                                       │            │
                                  projections     ws_frames ──▶ dashboard (WS, from_seq resume)
```

The event log is the source of truth; `tasks`/`messages`/`commands` are projections that
`relay db rebuild` can replay from scratch. Every write goes through one path (`EventLog.emit`).

## CLI

| Command | What it does |
|---|---|
| `relay serve` | HTTP + WS server (what the launchd service runs) |
| `relay "<msg>" [--to T-08]` | Oneline dispatch — same as `relay send`, no subcommand needed. Quote it |
| `relay send "<msg>" [--to T-08]` | Queue a message; `--to` delivers straight to a task |
| `relay ls [--all] [--json]` | Task table (ID, status, project, title, elapsed, session) |
| `relay tail <T-08>` | Live event stream for one task, from now on |
| `relay open` | Open the dashboard |
| `relay attach <T-08> [--print-only]` | Take the attach lease, run `claude attach`/`--resume`, release on exit |
| `relay pause` / `relay resume-all` | Kill switch on/off |
| `relay setup [--yes] [--service]` | First-run wizard |
| `relay doctor [--service] [--probe] [--json]` | Diagnostics; `--service` re-runs them under launchd |
| `relay db backup [file] \| restore <file> \| sweep \| rebuild` | Snapshot, restore, retention sweep, projection replay |
| `relay mcp` | MCP stdio bridge (`relay_send` / `relay_list` / `relay_status`) |
| `relay hook <event>` / `relay hook guard` | Worker session hook entry points |

Quote the message. An unquoted ASCII word is read as a subcommand or a typo of one — `relay resume all`, `relay tial T-08` exit 2 and
print the quoted form to paste, rather than spending a dispatch on it — and a command followed by prose it cannot take
(`relay pause the login task`) is refused the same way instead of running. Text no subcommand could be (CJK, punctuation, digits) is sent
as written, quoted or not. The shell eats `?` and `!` before relay sees them, which is one more reason to quote.

Human-readable English output by default; `--json` prints JSON only, for scripts.

## Configuration

`~/.config/relay/config.toml` (0600) — `relay setup` writes it, and every key has a default.

| Key | Default | Meaning |
|---|---|---|
| `port` | `8790` | Loopback HTTP/WS port |
| `claude_bin` | `"claude"` | Absolute path to the CLI (launchd has no brew/npm PATH) |
| `path_prepend` | `[]` | Dirs prepended to PATH under the service (claude's dir, node's dir) |
| `max_concurrent_agents` | `10` | Global permit pool size |
| `[dispatcher] model / effort / timeout_ms / rate_per_min` | `claude-fable-5` / `medium` / `60000` / `10` | One-shot routing call |
| `[dispatcher] max_split` | `4` | How many tasks one message may be split into. `1` turns splitting off |
| `[worker] model / advisor / permission_mode / allow_push` | `claude-opus-5` / `claude-fable-5` / `auto` / `false` | Worker session defaults |
| `[worker.effort] small / normal / epic` | `high` / `xhigh` / `xhigh` | Effort per task size |
| `[usage] daily_ceiling_tokens / max_tool_calls_per_turn` | `null` / `400` | Usage guards |
| `[usage.wall_clock_min] small / normal / epic` | `20` / `120` / `480` | Wall-clock budget per task size |
| `[idle] stop_after_min / close_after_hours` | `15` / `72` | Idle stop and auto-close |
| `[pool] subagent_parallel_per_task` | `null` | Per-task subagent cap (null = global pool only) |

Other files under `~/.config/relay/`: `relay.db`, `api-token`, `hook-token`, `token` (OAuth
fallback), `capabilities.json`, `hook-spool/`. Logs go to `~/Library/Logs/relay/`.

## Troubleshooting

- `relay doctor` — claude version/login, PATH, DB integrity, token modes, agent files, MCP
  registration path, capabilities. `relay doctor --service` re-runs the same list inside a
  throw-away launchd agent, which is where PATH and Keychain problems actually show up.
- Service did not come up: `~/Library/Logs/relay/stderr.log`. After a failed boot relay writes
  `~/.config/relay/service-failed` and sleeps instead of restart-looping — doctor reports it and
  prints the `rm` + `brew services restart relay` fix.
- A stopped server returns `relay: the server is not running` (exit 3) and suggests `brew services start relay` or `relay serve`.
- A worker's hooks stopped arriving: check `relay doctor` for quarantined spool entries.

## Development

The repository contains the runtime, embedded assets, and repeatable validation tooling:

| Directory | Purpose |
|---|---|
| `src/`, `shared/` | CLI, HTTP/WS gateway, event store, dispatcher, worker lifecycle and contracts |
| `agents/`, `web/` | Embedded worker definitions and dashboard |
| `test/` | Unit/integration tests, synthetic fixtures, development servers and opt-in live probes |
| `scripts/` | Build, binary verification, release and development entry points |
| `docs/` | Installation, architecture and contributor guides |

```sh
bun install --frozen-lockfile
bun run check                 # dashboard build, typecheck and offline tests
bun run test:binary           # production binary, isolated data and a fake Claude executable
bun run dev:fake              # real gateway + scripted workers; localhost:8814
bun run dev:ui                # synthetic visual fixtures; localhost:8813
```

See [architecture](docs/architecture.md), [development](docs/development.md), [historical archive index](docs/archive-index.md),
[test lanes and provenance](test/README.md), and [dashboard development](web/README.md).
Live CLI/service tests are explicitly separate from offline CI and may create billable workers.
Dated design, operating evidence and review journals are indexed in the Obsidian `Project/relay` hub.

For real development sessions, point hooks at the checkout using the `RELAY_BIN` environment
variable set to the absolute path of `scripts/relay-dev`. Keep the installed command intact.

## Requirements

- Bun 1.3.10+
- Claude Code CLI 2.1.251+ (logged in; `ANTHROPIC_API_KEY` is never used)
- git 2.54+, macOS

The current design is a single-user, localhost orchestrator. A shared enterprise service would
need an explicit design decision covering user identity, credentials, permissions and isolation.
