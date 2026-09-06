"""Pure evidence checks for the opt-in installed smoke. No CLI calls or mutations."""
import json
import sys


def evidence(mode, data, args):
    if mode == "project":
        name = args[0]
        projects = data.get("projects", data) if isinstance(data, dict) else data
        if not isinstance(projects, list) or any(not isinstance(project, dict) for project in projects):
            raise ValueError("invalid project snapshot")
        return "1" if any(project.get("name") == name for project in projects) else "0"
    if mode == "task":
        message_id, before = args
        message = next((m for m in data["messages"] if m["id"] == message_id), None)
        if not message or message.get("dispatch_state") == "pending":
            return ""
        task_id = message.get("task_uuid")
        task = next((t for t in data["tasks"] if t["uuid"] == task_id), None)
        if not task or task_id in before.split() or task.get("parent_uuid"):
            raise ValueError("receipt is not a new root task")
        return task_id
    if mode == "session":
        task = data.get("task", data)
        # The one-turn installed smoke claims only one generation. Broader lifecycle
        # evidence belongs to owned-cleanup integration tests and the live recovery gate.
        session = task.get("session_id")
        if task.get("process_generation") != 1 or not isinstance(session, str) or not session:
            raise ValueError("single generation with a known session ID required")
        return session
    if mode == "remaining":
        session = args[0]
        if not isinstance(data, list) or any(not isinstance(row, dict) for row in data):
            raise ValueError("invalid roster")
        if any(not isinstance(row.get("sessionId"), str) or not row["sessionId"] for row in data):
            raise ValueError("roster contains unresolved session identities")
        return ", ".join(str(row.get("id", "?")) for row in data if row["sessionId"] == session)
    raise ValueError("unknown evidence mode")


if __name__ == "__main__":
    try:
        print(evidence(sys.argv[1], json.load(sys.stdin), sys.argv[2:]))
    except (ValueError, KeyError, TypeError, IndexError) as error:
        print(f"Smoke evidence incomplete: {error}", file=sys.stderr)
        sys.exit(1)
