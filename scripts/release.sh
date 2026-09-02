#!/bin/sh
set -eu
VER="$1"; cd "$(dirname "$0")/.."
# package.json only — no git operations here; a no-op when the release commit already carries the version
[ "$(bun -p "require('./package.json').version")" = "$VER" ] || bun pm version "$VER" --no-git-tag-version >/dev/null
sh scripts/compile.sh "$VER"
ARM=$(grep arm64 dist/SHA256SUMS | cut -d' ' -f1); X64=$(grep x64 dist/SHA256SUMS | cut -d' ' -f1)
TAP="${TAP_DIR:-$HOME/workspace/homebrew-tap}"; [ -d "$TAP" ] || gh repo clone JeongJaeSoon/homebrew-tap "$TAP"
sed -e "s/version \"[^\"]*\"/version \"$VER\"/" -e "s/ARM64_SHA256/$ARM/" -e "s/X64_SHA256/$X64/" Formula/relay.rb > "$TAP/Formula/relay.rb"
cat <<EOF
built dist/*.tar.gz + dist/SHA256SUMS and wrote $TAP/Formula/relay.rb
no git/GitHub writes were performed — finish by hand (CLAUDE.md: GitHub writes go through /code-flow:*):
  1. /code-flow:commit                       # package.json: release v$VER
  2. git tag v$VER && /code-flow:commit-push-pr push-only
  3. gh release create v$VER dist/*.tar.gz dist/SHA256SUMS --title "relay v$VER" --notes-file CHANGELOG.md
  4. (cd $TAP && /code-flow:commit-push-pr)  # tap formula
EOF
