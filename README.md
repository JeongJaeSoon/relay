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

Human-readable Korean output by default; `--json` prints JSON only, for scripts.

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
- `relay: 서버가 꺼져 있습니다` (exit 3) from any CLI command: `brew services start relay`.
- A worker's hooks stopped arriving: check `relay doctor` for quarantined spool entries.

## Development

```sh
bun install
bun test
bunx tsc --noEmit
bun run build:web          # web/dist/index.html (inlined, embedded in the binary)
bun run compile 0.1.0      # dist/relay-<ver>-darwin-{arm64,x64}/relay + tarballs + SHA256SUMS
```

The compiled binary is ~59 MB (arm64) / ~64 MB (x64); the tarballs are ~21 MB / ~24 MB. The
dashboard HTML and `agents/*.md` are embedded via `with { type: "file" }` — there is no copy step.

For hooks to point at your working tree instead of an installed binary, symlink the dev shim and
set `RELAY_BIN`:

```sh
ln -sf "$PWD/scripts/relay-dev" ~/.local/bin/relay
RELAY_BIN="$HOME/.local/bin/relay" bun src/main.ts serve
```

## Requirements

- Bun 1.3.10+
- Claude Code CLI 2.1.251+ (logged in; `ANTHROPIC_API_KEY` is never used)
- git 2.54+, macOS

Design and plans live in the author's notes repo
(`docs/superpowers/{specs,plans}/2026-08-{29,30}-relay-*`).
