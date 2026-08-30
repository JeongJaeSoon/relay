# Phase 0 spikes

Experiments that measure what the real Claude Code CLI (2.1.251) does, so the core server (plan 02)
is built on observed behaviour instead of assumptions. Results land in
`spikes/results/capabilities.json`; measured hook payloads land in `spikes/fixtures/*.json` and
become the golden fixtures of plan 02's contract tests.

## Rules

- Every spike session is named `relay-spike:<something>`. Nothing else is ever touched.
- `--effort low`, minimal prompts, `ANTHROPIC_API_KEY` stripped from the child env (`lib.ts` `CLEAN_ENV`).
- Every script cleans up (`claude stop` + `claude rm`) on success, failure, and Ctrl-C.
- `bun spikes/scripts/cleanup.ts` is the backstop that removes every leftover `relay-spike:*` session.

## Order

```sh
bun spikes/scripts/sandbox.ts        # (re)create spikes/sandbox — a throwaway git repo
bun spikes/scripts/01-gate.ts        # ① CLI capability gate     — go/no-go
sh  spikes/scripts/01-launchd-auth.sh # ① launchd auth context
bun spikes/scripts/02-delivery-matrix.ts # ② delivery per process state — go/no-go
bun spikes/scripts/03-verdict.ts     # ③ Stop verdict inputs     — go/no-go
bun spikes/scripts/04-races.ts       # ④ race matrix
bun spikes/scripts/05-permits.ts     # ⑤ subagent permit gate
bun spikes/scripts/06-spool.ts       # ⑥ hook spool fault injection
bun spikes/scripts/06-permhold.ts    # ⑥ PermissionRequest hold
bun spikes/scripts/07-identity.ts    # ⑦ identity and orphans
bun spikes/scripts/09-burst.ts       # ⑨ dispatcher burst, timeout, kill switch
bun spikes/scripts/10-bun-mcp.ts     # ⑩ bun binary + MCP bridge
```

`①②③` are the gate: all three must pass before plan 02 starts. `④`–`⑩` may run alongside 02.

## Experiments

| # | script | question |
|---|---|---|
| ① | `01-gate.ts`, `01-launchd-auth.sh` | required flags, `agents --json` vocabulary, `--bg --resume` context, `--settings` hook merge, `--agent` vs CLI flag precedence, `--tools ""`, `--json-schema`, `--no-session-persistence`, launchd auth |
| ② | `02-peer.ts`, `02-delivery-matrix.ts` | peer socket registration, raw inbound/ack frames, delivery to a busy / idle / stopped worker |
| ③ | `03-verdict.ts` | Stop hook inputs behind the done / question / blocked / background verdict; `AskUserQuestion` blocked by `disallowedTools` |
| ④ | `04-races.ts` | stop↔send, idle-stop↔reply, interrupt↔SubagentStop, receiver restart↔hook POST, `kill -9` and supervisor restart |
| ⑤ | `05-permits.ts` | can a `PreToolUse(Agent)` hook deny subagent spawns beyond N, and does the worker continue sequentially |
| ⑥ | `06-spool.ts`, `06-permhold.ts`, `hook-spool.ts` | spool under faults (receiver down, restart drain, 20 concurrent, SIGKILL mid-write, malformed); holding a `PermissionRequest` response |
| ⑦ | `07-identity.ts` | duplicate names, `.relay-owner`, deleted cwd, `claude rm` on a dirty worktree, `~/.claude/jobs/<id>/state.json` |
| ⑧ | `08-recovery.md` | what `agents --json --all` shows per state after the receiver restarts |
| ⑨ | `09-burst.ts`, `dispatch.ts` | dispatcher latency/accuracy/cost over 50 messages, timeout kill, kill switch stop+resume |
| ⑩ | `10-bun-mcp.ts` | `bun build --compile` binary: http, ws, `bun:sqlite`, embedded html, spawning `claude`, MCP round trip |

## Steps that need the user

Some steps are blocked for an agent session (the auto-mode classifier refuses session spoofing and
`git push`), so the user runs them in tmux:

- **② Step 2–3** — register `02-peer.ts` as a messaging peer and capture the raw inbound/ack socket
  frames from an interactive `claude` session (`SendMessage` to `relay-spike`).
- **④ Step 2** — `claude attach <id>` on a worker, then `claude --bg --resume <uuid> "…"` from
  another window, to see how attach and send interact.
- **⑥ Step 3** — instruct a worker to `git push` and to write outside its worktree, to capture
  `PermissionDenied` / `PermissionRequest` payloads and the guard behaviour.
- **⑧** — the attached-worker row of the recovery checklist.

The exact commands live in each task's section of
`docs/superpowers/plans/2026-08-30-relay-01-phase0-spike.md`, and in `08-recovery.md`.

## Results

See `spikes/results/capabilities.json` (committed) and the summary table at the end of this file
once the run is complete. `spikes/results/*.jsonl` (raw hook logs) are gitignored.
