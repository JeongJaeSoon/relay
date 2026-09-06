#!/usr/bin/env bash
# Read-only operational observation. Failure must never become an empty roster.
read_roster() {
  local destination="$1" pending
  pending="$(mktemp "${destination}.XXXXXX")" || return 1
  if ! claude agents --json --all >"$pending" 2>"${destination}.error"; then
    rm -f "$pending"
    return 1
  fi
  if ! python3 - "$pending" <<'PY'
import json, sys
with open(sys.argv[1]) as source:
    rows = json.load(source)
if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
    raise SystemExit(1)
PY
  then
    rm -f "$pending"
    return 1
  fi
  mv "$pending" "$destination"
}
