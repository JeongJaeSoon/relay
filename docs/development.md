# Development

Relay is a Bun and TypeScript project with an embedded vanilla web dashboard. See [architecture.md](architecture.md) before changing lifecycle, ownership, event ordering, recovery, or security behavior.

## Setup and routine checks

```sh
bun install --frozen-lockfile
bun run check
```

The web build is required before binary and end-to-end tests because the compiled server embeds `web/dist/index.html`.

For a focused dashboard pass:

```sh
bun run test:web
bun run build:web
bun run typecheck
```

For the production binary, use the dedicated build-and-smoke command:

```sh
bun run test:binary
```

Testing an already installed service is an opt-in live check and requires a throwaway Git project:

```sh
RELAY_LIVE_TESTS=1 bash test/live/smoke-installed.sh <registered-project-name>
```

## Local development

The fake worker path exercises the real gateway, database, WebSocket, and dashboard without touching live Claude sessions:

```sh
bun test/support/dev-server.ts
```

The UI audit harness serves synthetic fixtures and reloads the current dashboard assets on request:

```sh
RELAY_UI_AUDIT_PORT=18814 bun test/support/ui/serve.ts
```

The canonical synthetic query flags are listed in [`test/README.md`](../test/README.md). Treat harness behavior as UI evidence, not as proof of native worker integration. Update that list with `test/support/ui/fixture.js` whenever a fixture flag changes.

## Change rules

- Append database migrations. Never edit a migration that has shipped.
- Emit durable changes through `EventLog`; do not update projection tables as an independent source of truth.
- Preserve transaction boundaries when a request state and its visible response must remain aligned.
- Treat task UUID plus process generation as identity. Do not use a session name, short ID, PID, or current `tasks.session_id` as the complete lifecycle record.
- Treat roster failures as unknown. Do not infer that a session disappeared from a failed or incomplete roster read.
- Keep the recovery write barrier up after an unavailable roster read and retry without overlapping recovery passes. A lifecycle hook replayed after a roster snapshot is newer evidence than that snapshot.
- Require a matching `.relay-owner` before Relay controls or removes a worktree. Foreign and ambiguous sessions are observation-only.
- Stop every owned generation and recheck liveness before removing a session or shared worktree.
- Do not accept a worker follow-up after task-level close cleanup starts. Interrupt-only stops are not closes and remain resumable.
- Keep worker CLI compatibility code under `src/runner/` and cover measured protocol behavior with fixtures.
- Keep user-facing strings in English while preserving intentional Korean input matchers.
- Never put tokens, private transcripts, or real session data in fixtures, logs, screenshots, issues, or pull requests.

## Testing strategy

Use the narrowest relevant test while iterating, then run the full required set once the change is stable.

| Change | Focused evidence |
|---|---|
| Event/projection/replay | `test/unit/core/` plus replay and state invariant tests |
| Dispatch or Ask | dispatcher, gateway message, and integration pipeline tests |
| Worker protocol | `test/unit/runner/` with recorded synthetic fixtures |
| Ownership, recovery and cleanup | lifecycle/runtime unit tests plus `test/integration/owned-cleanup.test.ts` and follow-up generation tests |
| Dashboard | relevant `web/test/` files, full web tests, build, and viewport interaction checks |
| CLI/package | CLI unit tests, binary integration tests, compile, and installed smoke script |

Tests using fake runners prove Relay's orchestration logic. Tests using the UI harness prove browser behavior against synthetic state. Native Claude checks, launchd service checks, and installed Homebrew checks are separate evidence classes and must be reported separately.

Everything under `test/live/` is opt-in. These probes can start native Claude sessions, manipulate throwaway worktrees, exercise launchd or an installed binary, and consume subscription usage; the default test suite must never run them. Store transient live output under the ignored `test/artifacts/live/` tree. Operational gate coverage remains incomplete and is tracked by GitHub issue #44, so a green default suite is not evidence that every live or release gate passed.

## Live verification safety

Use invented projects, paths, task IDs, messages, and sessions for normal testing. Before a native-session test, classify every visible session and worktree. Do not stop, remove, adopt, or write into a session unless its Relay ownership is proven for that test.

For lifecycle or cleanup changes, verify the full sequence: database task and `process_instances`, outbox commands, current Claude roster, owner stamp, worktree and branch state, then the visible dashboard result. Keep failures and unverified steps in the report.

The Phase 0 probes now live in `test/live/probes/`; `test/live/probes/08-recovery.md` remains an unexecuted interactive checklist. Sanitized deterministic protocol fixtures live in `test/fixtures/`. Runtime code may embed only the minimal protocol contract under `src/runner/protocol/`, not historical QA output.

UI reviews should record the source revision, fixture route, viewport, expected action, observed result, and direct evidence. Screenshots support layout findings but do not prove keyboard, focus, state-transition, or backend behavior.

## Documentation

Keep stable developer and user contracts in this repository. Dated QA runs, design exploration, and work journals belong in the Relay Obsidian project archive, where they must be labeled historical and linked to the tested commit. Preserve raw evidence or a content hash and Git history location before deleting redundant repository copies.

The deletion-to-archive map, parent Git paths, and source hashes are recorded in [archive-index.md](archive-index.md).

Architectural changes must begin with a GitHub issue that records the current contract, proposed adjustment, compatibility and migration impact, and acceptance evidence. Do not silently expand Relay into provider-neutral, multi-user, team, or remote operation.
