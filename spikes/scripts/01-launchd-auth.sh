#!/bin/sh
# ① Does a claude CLI spawned from a launchd user agent (no interactive shell) authenticate with the CLI login?
set -eu
LABEL=dev.relay.spike-auth
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$REPO/spikes/results/launchd-auth.json"
CLAUDE="$(command -v claude)"
rm -f "$OUT"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>-c</string>
    <string>env -u ANTHROPIC_API_KEY "$CLAUDE" -p "reply with exactly OK" --output-format json --tools "" --max-turns 1 --effort low --model claude-sonnet-5 > "$OUT" 2>/tmp/relay-spike-auth.err</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
for i in $(seq 1 60); do [ -s "$OUT" ] && break; sleep 1; done
launchctl bootout "gui/$(id -u)/$LABEL" || true; rm -f "$PLIST"
if grep -q '"is_error":false' "$OUT" 2>/dev/null && grep -q 'OK' "$OUT"; then echo "PASS launchd auth (keychain reachable)"; RES=keychain
elif grep -qi 'not logged in\|authentication' "$OUT" /tmp/relay-spike-auth.err 2>/dev/null; then echo "FAIL launchd auth — need CLAUDE_CODE_OAUTH_TOKEN fallback"; RES=needs-token
else echo "FAIL launchd auth — unknown, see $OUT and /tmp/relay-spike-auth.err"; RES=unknown; fi
bun -e "import('$REPO/spikes/scripts/lib.ts').then(m=>m.record({launchdAuth:'$RES'}))"
