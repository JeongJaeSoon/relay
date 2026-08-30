#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
VER="${1:-$(bun -p "require('./package.json').version")}"
bun run build:web
bun test
rm -rf dist && mkdir -p dist
for ARCH in arm64 x64; do
  OUT="dist/relay-$VER-darwin-$ARCH"; mkdir -p "$OUT"
  # dotted define: the code keeps reading process.env.RELAY_VERSION (an identifier define would be ignored)
  bun build --compile --minify --target="bun-darwin-$ARCH" --define "process.env.RELAY_VERSION=\"$VER\"" src/main.ts --outfile "$OUT/relay"
  codesign -s - -f "$OUT/relay" 2>/dev/null || true   # Bun output is already ad-hoc signed; -f re-signs quietly
  tar -C dist -czf "dist/relay-$VER-darwin-$ARCH.tar.gz" "relay-$VER-darwin-$ARCH"
done
(cd dist && shasum -a 256 *.tar.gz > SHA256SUMS && cat SHA256SUMS)
