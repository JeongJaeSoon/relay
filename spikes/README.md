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

## Results (run 2026-08-30, CLI 2.1.251, bun 1.3.10)

Full data in `spikes/results/capabilities.json` (also copied to
`~/.config/relay/capabilities.json`, which 02's `runner/capabilities.ts` reads).
`spikes/results/*.jsonl` (raw hook logs) are gitignored.

| # | verdict | evidence |
|---|---|---|
| ① gate | **PASS** | `GATE PASSED`; `bgResume: context-kept`; every required flag present; `--json-schema` → `structured_output`. launchd auth BLOCKED (see below) |
| ② delivery | **PASS (go)** | socket delivery lands on an idle worker, burst 10/10 exactly once; a busy worker drops it, so busy/stopped go through `--bg --resume` |
| ③ verdict | **PASS** | `RELAY: done/question/blocked` all parse from `last_assistant_message`; `background_tasks` populated; `AskUserQuestion` blocked |
| ④ races | PASS (recorded) | supervisor restarts a `kill -9`'d worker in ~12s; `--bg --resume` forks a new session id; no `SubagentStop` when the parent is stopped; hooks lost during a 6s receiver outage |
| ⑤ permit | PASS | `PreToolUse(Agent)` deny held subagents to 1 of 3; the worker did the rest sequentially |
| ⑥ spool / permhold | PASS | spool 5/5; a held `PermissionRequest` blocks the worker for exactly the hold; a hook TIMEOUT allows the tool. Guard step BLOCKED |
| ⑦ identity | PASS | two sessions share a name; `claude rm` keeps a dirty/unpushed worktree and the session with it |
| ⑧ recovery | **BLOCKED** | needs an interactive `claude attach`; procedure in `08-recovery.md` |
| ⑨ dispatcher | PASS | 10/10 routing accuracy, p50 7.4s / p95 10.1s, ~99k tok and ~$0.67 per message, timeout kill exit 143 in 1.7s, kill switch 3/3 stopped and resumed with context |
| ⑩ bun / MCP | PASS | 61MB compiled binary: http, ws, `bun:sqlite`, embedded html, spawning `claude`, MCP round trip |

### Corrections to the roadmap this run produced

- `WorktreeCreate` / `WorktreeRemove` are **provider** hooks, not observation hooks — registering one
  and returning nothing kills the session before init.
- `agents --json` reports the **launch** cwd, not the worktree, and background rows usually carry no
  `pid`. The worktree path comes from the hook payload `cwd`; the pid and the live idle/busy status
  come from `~/.claude/sessions/<pid>.json`, matched on `sessionId`.
- `--advisor` does not exist in 2.1.251, so the epic-task advisor in the roadmap has no flag.
- `claude --bg --resume <uuid>` **forks** (new session id, `SessionStart source: "fork"`); the daemon's
  own respawn keeps the session id (`source: "resume"`). Task identity must follow the fork chain.
- The cross-session socket has **no ack frame**: a send is `unknown` until the `[relay #…]` marker
  appears in the worker's `UserPromptSubmit`.
- A `PermissionRequest` payload has **no `tool_use_id`**; correlate with the preceding `PreToolUse`.
- A `PermissionRequest` hook timeout **allows** the tool, so relay's auto-deny must fire first.
- `claude rm` refuses (keeps the session) when the worktree has uncommitted or unpushed work.

### Still needs the user

1. **launchd auth (①)** — `launchctl bootstrap` is refused by this session's permission system:
   `sh spikes/scripts/01-launchd-auth.sh`
2. **attach ↔ send (④ Step 2)** — attach a worker in one terminal, then from another:
   `claude --bg --resume <uuid> "[relay #att0001] reply ATTACHED"`, and record what each side shows.
3. **guard (⑥ Step 3)** — a worker told to `git push` and to write outside its worktree, to capture
   the `PermissionDenied` payload and the deny-rule behaviour.
4. **recovery checklist (⑧)** — `spikes/scripts/08-recovery.md`.
