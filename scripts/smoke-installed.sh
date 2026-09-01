#!/usr/bin/env bash
# scripts/smoke-installed.sh — drive the *installed* relay (brew binary + launchd service) through one real task on a Mac.
#
# This is the tier the repo's tests cannot cover: the Homebrew binary, the launchd service, a real `claude --bg` worker,
# real hooks, and a real `claude rm`. It exercises what `relay doctor` only inspects. Everything it observes is written
# to a report so the run can be quoted in a release checklist instead of "tests pass".
#
#   scripts/smoke-installed.sh <project-name> [--commit] [--keep] [--timeout-min N]
#
#   <project-name>   a project already registered with relay (`relay setup`, or the dashboard's Projects panel)
#   --commit         ask the worker to make a local commit — this is the shape `claude rm` refuses (unpushed work),
#                    so close is expected to end in `error` with the kept worktree, not `closed`; see CHANGELOG 0.1.3
#   --keep           do not close the task at the end (leave it for `relay attach`)
#   --timeout-min N  how long to wait for the worker (default 20)
#
# Needs: the relay binary on PATH, the service up, python3 (ships with the Xcode CLT that git needs anyway), curl.
# Never touches sessions relay does not own; the only writes are one message and one close on the task it created.
set -u
NAME="${1:-}"; shift || true
COMMIT=0; KEEP=0; TIMEOUT_MIN=20
while [ $# -gt 0 ]; do case "$1" in --commit) COMMIT=1;; --keep) KEEP=1;; --timeout-min) TIMEOUT_MIN="$2"; shift;; *) echo "unknown flag $1" >&2; exit 2;; esac; shift; done
[ -n "$NAME" ] || { sed -n '3,20p' "$0"; exit 2; }

HOME_DIR="${RELAY_HOME:-$HOME/.config/relay}"
PORT="$(python3 - "$HOME_DIR/config.toml" <<'PY' 2>/dev/null || echo 8790
import re,sys
try: print(re.search(r'^\s*port\s*=\s*(\d+)', open(sys.argv[1]).read(), re.M).group(1))
except Exception: print(8790)
PY
)"
API="http://127.0.0.1:$PORT/api"
TOKEN="$(cat "$HOME_DIR/api-token" 2>/dev/null)" || { echo "no api token at $HOME_DIR/api-token — is relay set up?" >&2; exit 2; }
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${SMOKE_OUT:-$HOME_DIR/smoke}"; mkdir -p "$OUT"; REPORT="$OUT/$STAMP.md"; RAW="$OUT/$STAMP"; mkdir -p "$RAW"

j() { python3 -c 'import json,sys; d=json.load(sys.stdin); exec(sys.argv[1])' "$1"; }   # j '<python over d>' — no jq on a stock Mac
api() { curl -sS -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$@"; }
PASS=0; FAIL=0
gate() { # gate <name> <ok:0|1> <detail>
  if [ "$2" = 1 ]; then PASS=$((PASS+1)); printf '  ✔ %s — %s\n' "$1" "$3"; printf -- '- ✔ **%s** — %s\n' "$1" "$3" >>"$REPORT"
  else FAIL=$((FAIL+1)); printf '  ✘ %s — %s\n' "$1" "$3"; printf -- '- ✘ **%s** — %s\n' "$1" "$3" >>"$REPORT"; fi
}
section() { printf '\n%s\n' "$1"; printf '\n## %s\n\n' "$1" >>"$REPORT"; }

{
  echo "# relay installed-binary smoke — $STAMP"; echo
  echo "- host: $(sw_vers -productName 2>/dev/null) $(sw_vers -productVersion 2>/dev/null) · $(uname -m)"
  echo "- relay: $(command -v relay) · $(relay --version 2>/dev/null | head -1)"
  echo "- claude: $(command -v claude) · $(claude --version 2>/dev/null | head -1)"
  echo "- project: $NAME · mode: $([ $COMMIT = 1 ] && echo commit || echo read-only) · keep: $KEEP"
} >"$REPORT"
echo "report → $REPORT"

# ── 1. doctor ──────────────────────────────────────────────────────────────────────────────────────────────────────────
section "1. relay doctor"
relay doctor --json >"$RAW/doctor-before.json" 2>"$RAW/doctor-before.err"
if [ -s "$RAW/doctor-before.json" ]; then
  # drift has its own gate below — counting it here too would report one condition as two failures
  BAD="$(j 'print("; ".join(c["name"]+": "+c["detail"] for c in d if not c["ok"] and c["name"] != "CLI version drift"))' <"$RAW/doctor-before.json")"
  gate "doctor" "$([ -z "$BAD" ] && echo 1 || echo 0)" "${BAD:-all checks ok}"
else gate "doctor" 0 "no JSON output ($(head -c 200 "$RAW/doctor-before.err"))"; fi
STATE="$(api "$API/usage")" || { gate "service reachable" 0 "GET /api/usage failed on :$PORT — brew services start relay"; echo "aborting"; exit 1; }
echo "$STATE" >"$RAW/state-before.json"
DRIFT="$(printf '%s' "$STATE" | j 'print(d.get("cli_drift") or "")')"
gate "service reachable" 1 "port $PORT · version $(printf '%s' "$STATE" | j 'print(d.get("version"))') · delivery $(printf '%s' "$STATE" | j 'print(d.get("delivery_method"))')"
gate "cli drift" "$([ -z "$DRIFT" ] && echo 1 || echo 0)" "${DRIFT:+capabilities measured on $DRIFT — relay doctor --probe re-checks the --bg --resume gate; the rest is issue #42}${DRIFT:-capabilities match the installed CLI}"
PAUSED="$(printf '%s' "$STATE" | j 'print(1 if d.get("paused") else 0)')"; [ "$PAUSED" = 1 ] && gate "kill switch" 0 "relay is paused — nothing will run; relay resume-all"

# ── 2. baseline: what relay owns on the claude roster right now ────────────────────────────────────────────────────────
section "2. baseline"
claude agents --json >"$RAW/agents-before.json" 2>/dev/null || echo '[]' >"$RAW/agents-before.json"
BEFORE_RELAY="$(j 'print(sum(1 for a in d if str(a.get("name","")).startswith("relay:")))' <"$RAW/agents-before.json")"
BEFORE_UUIDS="$(api "$API/tasks?include=closed" | tee "$RAW/tasks-before.json" | j 'print(" ".join(t["uuid"] for t in d["tasks"]))')"
PROJ_OK="$(j "print(1 if any(p['name']=='$NAME' for p in d['projects']) else 0)" <"$RAW/tasks-before.json")"
gate "project registered" "$PROJ_OK" "$NAME"; [ "$PROJ_OK" = 1 ] || { echo "aborting"; exit 1; }
echo "  roster: $BEFORE_RELAY relay-owned session(s) before"; echo "- roster before: $BEFORE_RELAY relay-owned session(s)" >>"$REPORT"

# ── 3. one message → one task ──────────────────────────────────────────────────────────────────────────────────────────
section "3. dispatch"
if [ $COMMIT = 1 ]; then
  TEXT="New task in project $NAME: create a file SMOKE-$STAMP.md containing only the current date, commit it locally with the message 'smoke $STAMP', and finish. Do not push."
else
  TEXT="New task in project $NAME: run \`git status --short\` and \`git log -1 --oneline\`, report the output, and finish. Do not edit, create, or commit anything."
fi
SEND="$(relay send "$TEXT" 2>&1)"; echo "  $SEND"; echo "- send: \`$SEND\`" >>"$REPORT"
TASK=""; for _ in $(seq 1 36); do   # 3 minutes for the dispatcher (its own timeout is 60s)
  sleep 5
  TASK="$(api "$API/tasks?include=closed" | j "
before=set('$BEFORE_UUIDS'.split()); new=[t for t in d['tasks'] if t['uuid'] not in before and not t['parent_uuid']]
print(new[0]['uuid'] if new else '')")"
  [ -n "$TASK" ] && break
done
if [ -z "$TASK" ]; then
  LEDGER="$(api "$API/tasks" | j 'ms=[m for m in d["messages"] if m["role"]=="user"][-1:]; print("; ".join(f"{m[\"dispatch_state\"]} {m.get(\"dispatch_json\") or m.get(\"dispatch_error\") or \"\"}" for m in ms))')"
  gate "task created" 0 "no new task within 3 min — last request: $LEDGER"; echo "aborting (nothing to clean up)"; exit 1
fi
DISP="$(api "$API/tasks/$TASK" | tee "$RAW/task-created.json" | j 'print(d["task"]["display_id"] if "task" in d else d.get("display_id"))')"
gate "task created" 1 "$DISP ($TASK)"

# ── 4. wait for the worker ─────────────────────────────────────────────────────────────────────────────────────────────
section "4. worker"
FINAL=""; T0=$(date +%s)
while :; do
  ROW="$(api "$API/tasks?include=closed" | j "t=[t for t in d['tasks'] if t['uuid']=='$TASK'][0]; print(t['status'], t.get('short_id') or '-', t.get('process_generation'), (t.get('last_step') or '')[:60])")"
  ST="${ROW%% *}"; printf '\r  %s  %-14s %s' "$(date +%H:%M:%S)" "$ST" "${ROW#* }"
  case "$ST" in done|error|needs_review|cancelled|waiting_input|closed) FINAL="$ST"; echo; break;; esac
  [ $(( $(date +%s) - T0 )) -ge $(( TIMEOUT_MIN * 60 )) ] && { echo; FINAL="timeout"; break; }
  sleep 5
done
api "$API/tasks/$TASK" >"$RAW/task-final.json"
SUMMARY="$(j 't=d.get("task",d); print((t.get("last_summary") or "")[:200].replace("\n"," "))' <"$RAW/task-final.json")"
SESSION="$(j 't=d.get("task",d); print(t.get("short_id") or "-")' <"$RAW/task-final.json")"
case "$FINAL" in
  done)          gate "worker finished" 1 "done · session $SESSION · $SUMMARY";;
  waiting_input) gate "worker finished" 0 "stopped on a question — answer it in the dashboard or: relay \"<answer>\" --to $DISP · $SUMMARY";;
  timeout)       gate "worker finished" 0 "still running after ${TIMEOUT_MIN} min — relay tail $DISP";;
  *)             gate "worker finished" 0 "$FINAL · $SUMMARY";;
esac
HOOKS="$(j 'ev=d.get("events",[]); import collections; c=collections.Counter(e["type"] for e in ev); print(len(ev), "events ·", ", ".join(f"{k}×{v}" for k,v in sorted(c.items()) if k.startswith("hook.")))' <"$RAW/task-final.json" 2>/dev/null)"
gate "hooks arrived" "$(j 'print(1 if any(e["type"].startswith("hook.") for e in d.get("events",[])) else 0)' <"$RAW/task-final.json" 2>/dev/null || echo 0)" "${HOOKS:-no event list in task detail}"
echo; relay ls --all 2>&1 | head -20
{ echo; echo '```'; relay ls --all 2>&1 | head -20; echo '```'; } >>"$REPORT"

# ── 5. close → rm, and what the roster says afterwards ─────────────────────────────────────────────────────────────────
if [ $KEEP = 1 ]; then section "5. close (skipped: --keep)"; echo "- left open: relay attach $DISP" >>"$REPORT"
elif [ "$FINAL" = timeout ] || [ "$FINAL" = waiting_input ]; then section "5. close (skipped: task not finished)"
else
  section "5. close"
  api -X POST "$API/tasks/$TASK/close" >/dev/null
  CLOSED=""; for _ in $(seq 1 24); do sleep 5
    CLOSED="$(api "$API/tasks?include=closed" | j "t=[t for t in d['tasks'] if t['uuid']=='$TASK'][0]; print(t['status'], t.get('worktree_path') or '')")"
    case "${CLOSED%% *}" in closed|error) break;; esac
  done
  CST="${CLOSED%% *}"; WT="${CLOSED#* }"
  if [ $COMMIT = 1 ]; then
    # The documented shape: an unpushed local commit makes `claude rm` refuse, and relay must say so rather than claim closed.
    case "$CST" in
      error)  gate "close is honest about a refused rm" 1 "status error · worktree kept at $WT (expected with --commit; see CHANGELOG 0.1.3)";;
      closed) gate "close is honest about a refused rm" 0 "status closed although the worktree holds an unpushed commit — either the CLI now removes such sessions (re-measure: issue #42) or close is over-claiming again";;
      *)      gate "close is honest about a refused rm" 0 "still $CST after 2 min";;
    esac
  else
    case "$CST" in
      closed) gate "close removes the session" 1 "closed";;
      error)  gate "close removes the session" 0 "rm refused on a read-only task — worktree kept at $WT; relay doctor will list it (issue #37)";;
      *)      gate "close removes the session" 0 "still $CST after 2 min";;
    esac
  fi
  sleep 3; claude agents --json >"$RAW/agents-after.json" 2>/dev/null || echo '[]' >"$RAW/agents-after.json"
  LEFT="$(j "print(', '.join(f\"{a.get('id')} {a.get('name')} [{a.get('state')}]\" for a in d if str(a.get('name','')).startswith('relay:$DISP ')))" <"$RAW/agents-after.json")"
  AFTER_RELAY="$(j 'print(sum(1 for a in d if str(a.get("name","")).startswith("relay:")))' <"$RAW/agents-after.json")"
  if [ $COMMIT = 1 ] && [ "$CST" = error ]; then gate "roster" 1 "$DISP still registered as expected ($LEFT) · relay-owned before/after: $BEFORE_RELAY/$AFTER_RELAY"
  else gate "roster has no leftover for $DISP" "$([ -z "$LEFT" ] && echo 1 || echo 0)" "${LEFT:-none} · relay-owned before/after: $BEFORE_RELAY/$AFTER_RELAY"; fi
  relay doctor --json >"$RAW/doctor-after.json" 2>/dev/null
  KEPT="$(j 'print("; ".join(c["name"]+": "+c["detail"] for c in d if not c["ok"] and "session" in c["name"]))' <"$RAW/doctor-after.json" 2>/dev/null)"
  gate "doctor after close" "$([ -z "$KEPT" ] && echo 1 || echo 0)" "${KEPT:-no session checks failing}"
fi

# ── summary ────────────────────────────────────────────────────────────────────────────────────────────────────────────
section "Result"
echo "  $PASS passed · $FAIL failed · raw: $RAW"; echo "- **$PASS passed · $FAIL failed** · raw JSON in \`$RAW\`" >>"$REPORT"
echo "  report: $REPORT"
[ $FAIL = 0 ]
