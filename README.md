# relay

Personal multi-agent orchestrator for Claude Code.

One message in, immediate ack: a one-shot dispatcher routes it to a new or existing task, and
workers run as native `claude --bg` sessions in git worktrees. Observation is per-session hooks,
control is `claude stop/attach/--resume`, and a SQLite event log is the single source of truth.
A graph dashboard, a chat surface, and a CLI/MCP bridge ship as one Bun binary.

Status: under implementation. Design and plans live in the author's notes repo
(`docs/superpowers/{specs,plans}/2026-08-{29,30}-relay-*`).

## Requirements

- Bun 1.3.10+
- Claude Code CLI 2.1.251+ (logged in; `ANTHROPIC_API_KEY` is never used)
- git 2.54+, macOS

## Development

```sh
bun install
bun test
```
