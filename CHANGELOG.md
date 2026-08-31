# Changelog

## 0.1.3

Every defect in this release was found by reviewing v0.1.2 after it shipped, and most of
them were introduced by v0.1.2 itself: the Ask text sniffing, the ledger's reply
attribution, three of the four scheduler failures, and a `close` that claimed a cleanup
it had not achieved. Two were older — the exemption covering relay's own stops, and the
session leak that v0.1.2 was written to fix and did not.

### The zombie sessions, again — and why v0.1.2 barely helped

v0.1.2 claimed to stop sessions leaking. Measured afterwards, it mostly did not, and the
reason is a rule nobody had checked: **`claude rm` refuses to remove a session whose
worktree holds commits that exist nowhere else.** Not uncommitted changes — *unpushed*
ones. And relay's own worker convention produces exactly that shape: `agents/relay-worker.md`
tells every worker to commit locally and leave the tree clean, while `src/runner/settings.ts`
denies `Bash(git push*)` whenever `allow_push` is false, which is the default. A worker
that succeeds cannot push, so any task that made a commit is refused, without exception.
Re-measured against the CLI: dirty → refused; commit it so the tree is clean → still
refused, only the reason changes.

So the leak is not something relay can fix — the refusal is correct, protecting work that
exists in one place. What relay was doing wrong was *not saying so*.

- **`close` no longer claims a cleanup it did not achieve.** The terminal state is now
  projected from the `rm` result: applied means `closed`, refused means the task stays
  visible in `error` with the worktree path on it. Previously it wrote `closed`
  regardless, so the leak became invisible at the moment it happened.
- **`relay doctor` counts what is left**, in two lines that answer different questions:
  sessions whose disposal was refused, and sessions relay never attempted to dispose of
  at all — the second being an orphan that has no `rm` command to find it by.
- **Each refusal is reported in the CLI's own words**, with the kept worktree path.
  All three were previously flattened into "uncommitted work remains", which is false for
  the common one and sends the user looking for a dirty file that is not there.
- **A locked worktree is transient and is now treated that way** — held rather than
  failed, retried, and promoted to a visible failure only after 15 minutes. The bound is
  what makes "a lock clears itself" something the code enforces rather than assumes.

### Recovery paths that could not recover

- **Restarting a spawn-stranded task leaked the slot it was meant to return**, permanently
  and invisibly: the `unknown` spawn stayed at the queue head, so the resume behind it
  never ran, and the task sat at `starting` holding its permit. Neither the watchdog,
  nor recovery, nor a relay restart could clear it. Restart now re-runs the spawn, which
  adopts an already-started session when the owner stamp proves one is ours — and
  **refuses** rather than spawning over a live session it cannot place, because the
  alternative is two agents in one working tree.
- **A message stranded in `deciding` was unrecoverable.** `claude -p` is a child of the
  relay process, so a crash mid-decision left the message with no task, no answer and no
  button. Recovery now resets it, and a dispatcher that cannot even start marks it failed.
- **A permission question no longer loses its slot.** Invariant I6 says a task waiting on
  a permission request keeps its lease; three places encoded that rule as three shorter
  approximations, and two of them were wrong. There is now one predicate, `holdsSlot`.
- **relay's own `pause` could look like a crash.** The exemption covering relay's own
  stops had no generation scope, so a fork that came up afterwards and then genuinely
  crashed was recorded as expected — leaving a `running` task over a dead process that
  nothing recovers.

### The request ledger, corrected twice

The reply-attribution fix in this release went in, regressed on a real database, and was
fixed again before shipping. Both rounds are worth recording because the second was found
only by running the merged code against the user's own data rather than a fixture.

The claim queue paired replies to requests from the oldest end, which assumes every
waiting request eventually gets one. A database with history from before the 0.1.1
English migration breaks that: its oldest requests are answered by Korean prompts the
matcher does not recognise, so they wait forever at the head and take the later English
prompts instead. Pairing from the **newest** end removes the assumption's load-bearing
role rather than trying to enforce it — a shortfall now lands on the oldest rows, which
degrade, and an unmatched request cannot take a reply belonging to a request after it,
whatever the reason it went unmatched. A prompt is now recognised by exclusion, so those
Korean rows are read correctly rather than merely tolerated.

### The request ledger

- **Replies attach to the request they answer**, not the one they follow. The dispatcher
  decides one message at a time while messages are recorded on arrival, so any second
  request sent during a decision was recorded before the first request's answer — and the
  answer landed on the wrong row. With two stalled requests outstanding, each showed the
  other's reason.
- **A split reports the piece that needs reading**, and its failure reason comes from the
  piece that failed rather than from the first one.

### Ask

- **Ask intent travels as data, not as a `?` in the text.** The gateway already refused to
  read a leading `?` from github, slack, cron or MCP as a question; the dispatcher then
  re-read the stored text and undid that, so a work request from those sources became one
  line of chat and no task. Intent is now a column, set once at the boundary.
- **The model gets a second turn.** The structured output arrives as a tool call, so
  `--max-turns 1` cut off any turn that thought first. This was never only an Ask bug —
  routing shares the same call and had been failing the same way, silently.
- `relay_send` accepts `ask`, so a question can be asked through MCP at all.


## 0.1.2

Sessions stop leaking, a bare message dispatches, and every request you send is now
listed with what happened to it.

### The zombie sessions, in three parts

Dead `claude agents` entries piled up from three separate causes, and each needed its
own fix.

- **relay called its own resume a crash.** `claude --bg --resume` *forks*: a new
  session id, a `SessionStart` with `source: "fork"`, and the old process ending. The
  clause that recognised relay's own doing only knew about stops that went through a
  command, but the resume path calls `runner.stop()` directly — so a task crash-looped
  against its own resume. The exemption is now scoped to the one generation the resume
  interrupted, stamped on its own `command.running`; a newer generation dying is still
  a real crash, because swallowing that strands the task holding its slot.
- **Every superseded generation stayed registered.** Disposal covers all of them now,
  keyed on session id rather than a `short_id` that is NULL at the time it was read.
  A fork-resume only *stops* them: the generations share one worktree, and removing a
  dead one can delete the directory the live fork is working in. Removal waits for
  `close`, and a refused removal is recorded as failed rather than applied — a kept
  worktree means the session is still registered.
- **A task that ended in `error` never closed.** `close` is the only path that disposes
  of a session, and the idle deadline only called it for `done` and `cancelled`, so an
  errored task kept its session forever and there was no CLI command to do it by hand.
  `waiting_input` and `needs_review` stay excluded — they wait on a person.

### Dispatch

- **`relay "<message>"`** — no subcommand needed. A first argument shaped like a
  command (`^[A-Za-z][A-Za-z-]*$`) is refused with the quoted form to copy, so
  `relay tial T-08` is a typo rather than a message, and `relay pause the login task`
  no longer silently executes the kill switch. Any language without spaces dispatches
  as written.
- **The model gets a second turn.** The structured output is delivered as a tool call,
  so `--max-turns 1` cut off any turn that thought first — `terminal_reason:
  "max_turns"` and no output at all. This was never only an Ask bug: routing shares the
  same call and had been failing the same way, silently, whenever the model reasoned
  before answering.
- A spawn whose outcome relay could not read parks the task in `error` and returns its
  scheduler slot, instead of leaving it at `starting` holding the slot forever.
- Redispatch is refused once the decision has landed — re-deciding would mint a second
  set of tasks for one request.
- A split may no longer put two of its pieces in the same repository, and it now names
  every task it made in the dispatcher's context, so "cancel that" can resolve them.

### Dashboard

- **A request ledger** replaces the dispatch log: one row per message you sent, what
  relay decided, which task is carrying it, whether an answer came back, and the action
  that unblocks it. Stranded requests sort to the top rather than sitting under forty
  settled ones. A split names all of its tasks and takes its state from the piece that
  most needs reading.
- **Ask** — a question that stays a question. Ask about a running task and it is
  answered from that session's transcript tail, redacted, without sending the worker
  anything. `?` at the start of the composer does the same thing.
- **Sessions you started yourself** appear under "Outside relay" — seen and stoppable,
  never managed.
- Multi-line chat input: Enter sends, Shift+Enter breaks, and the box grows to eight
  lines. Enter during Hangul composition is left alone, or the candidate can never be
  confirmed.
- The dashboard no longer went blank on reload when an answered question sat in the
  last 200 messages.
- The pool card refreshes on a pause or resume instead of only when a task changes,
  and it no longer reports being over a usage ceiling that was never configured.

### Other

- `relay doctor` and the dashboard warn when the Claude Code CLI has moved since
  `capabilities.json` was measured, and at boot when it is below the supported floor.
  The probe no longer stamps away the very signal the check exists to raise.
- A rate-limit false positive no longer trips the kill switch: `express-rate-limit`
  scrolling past in a `bun install` was enough to stop all work.
- Code comments are English.

## 0.1.1

The product speaks English, and a project root must be a git repository.

- **English throughout.** Every user-facing string — CLI output, dashboard, chat, notifications,
  dispatcher answers, MCP tool results — is English. The Korean *input*-matching patterns stay:
  reading English labels does not stop anyone typing `상태?`, and the status fast path must still
  catch it.
- **A project root must be a git repository.** Registering a plain directory produced a project
  with no worktree per task and widened the guard's realpath boundary from one repository to the
  whole tree. `POST /api/projects` now rejects it — that is the boundary the dashboard form posts
  through too. Projects registered before the rule are left alone and flagged by `relay doctor`.
- **Point setup at a parent directory.** A non-repository path is scanned two levels deep for
  repositories and offers them for selection, instead of being registered as one bad project.
- **A real terminal UI for `relay setup`** (`@clack/prompts`): arrow-key multiselect for the
  discovered repositories, spinners on the two probes that take a minute each, Ctrl-C as a cancel.
  Prompts render only on a TTY — clack blocks forever on a closed stdin, so `--yes` and service
  contexts take defaults and draw nothing.
- `relay` with no arguments prints help instead of starting a server and provisioning
  `~/.config/relay`.
- Ship the MIT license the formula already claimed.

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
- A worker reads its inbox socket mid-turn, so a send goes straight through whether the worker is
  busy or idle; only the resume path waits for a turn boundary.
- `UserPromptSubmit` fires only for a message that starts a turn, so it cannot prove a send landed.
  A socket send is never optimistically `accepted`: the `[relay #<id>]` marker is the only proof,
  found in `UserPromptSubmit`, in the worker's reply frame, or in the transcript.
