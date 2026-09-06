#!/bin/sh
# ① Does a claude CLI spawned from a launchd user agent (no interactive shell) authenticate with the CLI login?
set -eu
[ "${RELAY_LIVE_TESTS:-}" = "1" ] && [ "${1:-}" = "--live" ] || {
  echo "This probe starts a launchd job and a paid Claude turn." >&2
  echo "Run explicitly: RELAY_LIVE_TESTS=1 $0 --live" >&2
  exit 2
}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)
RUN_ID="$(date +%Y%m%dT%H%M%S)-$$"
LABEL="dev.relay.live-auth.$(id -u).$$"
RUN_DIR="$REPO/test/artifacts/live/results/launchd-auth-$RUN_ID"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/relay-launchd-auth.XXXXXX")
PLIST="$TMP_ROOT/$LABEL.plist"
OUT="$RUN_DIR/result.json"
ERR="$RUN_DIR/stderr.log"
CLAUDE="$(command -v claude)"
mkdir -p "$RUN_DIR"
BOOTSTRAPPED=0
cleanup() {
  if [ "$BOOTSTRAPPED" = "1" ]; then launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/env</string><string>-u</string><string>ANTHROPIC_API_KEY</string>
    <string>$CLAUDE</string><string>-p</string><string>reply with exactly OK</string>
    <string>--output-format</string><string>json</string><string>--tools</string><string></string>
    <string>--max-turns</string><string>1</string><string>--effort</string><string>low</string>
    <string>--model</string><string>claude-sonnet-5</string>
  </array>
  <key>StandardOutPath</key><string>$OUT</string>
  <key>StandardErrorPath</key><string>$ERR</string>
  <key>RunAtLoad</key><true/>
</dict></plist>
PL
launchctl bootstrap "gui/$(id -u)" "$PLIST"
BOOTSTRAPPED=1
for i in $(seq 1 60); do [ -s "$OUT" ] && break; sleep 1; done
cleanup
BOOTSTRAPPED=0
if grep -q '"is_error":false' "$OUT" 2>/dev/null && grep -q 'OK' "$OUT"; then echo "PASS launchd auth (keychain reachable)"; RES=keychain
elif grep -qi 'not logged in\|authentication' "$OUT" "$ERR" 2>/dev/null; then echo "FAIL launchd auth — login unavailable in launchd context"; RES=needs-login
else echo "FAIL launchd auth — unknown, see $OUT and $ERR"; RES=unknown; fi
printf '%s\n' "$RES" > "$RUN_DIR/verdict.txt"
[ "$RES" = keychain ]
