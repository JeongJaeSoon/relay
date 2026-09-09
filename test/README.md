# Validation and test data

Run `bun run check` before opening a PR. It builds the dashboard, typechecks the repository,
and runs the offline suite. These checks do not require Claude login or start real workers.

| Lane | Command | Evidence |
|---|---|---|
| Unit | `bun run test:unit` | Event/projection invariants, guards, recovery decisions, routing and protocol parsing |
| Integration | `bun run test:integration` | Real HTTP/WS/SQLite flow with scripted workers; startup failure and cleanup |
| Dashboard | `bun run test:web` | Adapter replay, attribution, request navigation, layout and chat timestamps |
| Compiled binary | `bun run test:binary` | Actual production entry, embedded dashboard, CLI and guarded gateway with a fake CLI |
| Visual development | `bun run dev:ui` | Invented UI data at localhost:8813 (query flags below) |
| Gateway development | `bun run dev:fake` | Real gateway with FakeRunner at localhost:8814, fresh temporary home and project |
| Native worker | `bun run test:live` | Opt-in real Claude E2E in a temporary project |
| Installed service | `RELAY_LIVE_TESTS=1 bash test/live/smoke-installed.sh <registered-project-name>` | Explicit real task, hooks, close and retained worktree on an installed Mac service |

`RELAY_DEV_PORT` and `RELAY_UI_AUDIT_PORT` change development ports. Development data is
synthetic and separate from the installed service. The fake server prints its temporary URL;
its temporary data can be inspected after stopping it.

The synthetic UI harness accepts `/` plus these composable query flags: `few`, `many`, `empty`,
`history`, `dark`, `slow`, `fail`, `missing`, `root`, `notifications`, `updates`, and
`request-layout=plain|dividers`. This is the canonical route list; update it together with
`test/support/ui/fixture.js`.

## Live probes

The scripts under `test/live/probes/` recheck native Claude CLI assumptions. They are opt-in
operator tools, not automatic CI, and can create real sessions that consume subscription usage.
Set `RELAY_LIVE_TESTS=1` explicitly before invoking a probe. Start with `sandbox.ts`; it refuses
to overwrite an existing sandbox. Stop and inspect retained workers before removing that sandbox.

Raw output goes to ignored `test/artifacts/live/{results,captures,sandbox}`. Never copy raw
transcripts, session registries, credentials, or private project paths into tracked fixtures.
The canonical contracts under `test/fixtures/` are synthetic; see their provenance README.

The current macOS/launchd and interactive attach/recovery gates remain tracked in
[issue #44](https://github.com/JeongJaeSoon/relay/issues/44). Offline tests and historical
capability snapshots are not proof that these gates passed on a new Claude CLI version.
The historical sample-binary probe was replaced by the production `test:binary` lane;
its live Claude-to-MCP round trip is a separate manual gate.

## Review and merge evidence

Record the tested commit SHA, commands, failures/skips, independent review scope and QA outcome
in the PR. Review the final diff after any follow-up commit. Before merging, compare the remote
PR head with that reviewed SHA and confirm required CI passed. Repository-enforced stale-review
gates are tracked separately in [issue #47](https://github.com/JeongJaeSoon/relay/issues/47).

If live validation leaves an uncertain or retained session, report it as incomplete. A failed
roster query does not mean an empty roster. Never remove an unowned session or worktree just
to make a smoke report green.
