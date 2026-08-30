// src/hooks/ingest.ts — turn native hook payloads into events (contract: roadmap B4).

/** Every hook event relay understands on `POST /api/hooks`. */
export const ALL_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied", "SubagentStart", "SubagentStop", "Notification", "Stop", "SessionEnd", "WorktreeCreate", "WorktreeRemove"];
/** What `--settings` actually registers on a worker session. `WorktreeCreate` is a *provider* hook, not an observation
 *  hook: Phase 0 measured that registering it makes the CLI abort session init ("hook succeeded but returned no
 *  worktree path"), so relay must never inject it — it stays in ALL_HOOK_EVENTS only so a payload from elsewhere is
 *  still accepted rather than 400'd. */
export const INJECTED_HOOK_EVENTS = ALL_HOOK_EVENTS.filter((e) => e !== "WorktreeCreate");
