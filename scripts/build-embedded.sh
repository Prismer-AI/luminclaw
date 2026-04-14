#!/usr/bin/env bash
# Build the embedded bundle + emit manifest with version + sha256 + bundle stats.
# Usage: bash scripts/build-embedded.sh

set -euo pipefail

cd "$(dirname "$0")/.."

echo "→ Compile TypeScript (for d.ts emission)"
npx tsc -p tsconfig.json

echo "→ Build IIFE bundle"
node esbuild.embedded.mjs

BUNDLE=dist/luminclaw-core.js
DTS=dist/luminclaw-core.d.ts

if [ ! -f "$BUNDLE" ]; then
  echo "ERROR: $BUNDLE not produced" >&2
  exit 1
fi

# tsc emits dist/embedded.d.ts; copy under the bundle name for clarity.
if [ -f dist/embedded.d.ts ]; then
  cp dist/embedded.d.ts "$DTS"
fi

VERSION=$(node -p "require('./package.json').version")
SHA256=$(shasum -a 256 "$BUNDLE" | awk '{print $1}')
GZIP_BYTES=$(gzip -c "$BUNDLE" | wc -c | tr -d ' ')
RAW_BYTES=$(wc -c < "$BUNDLE" | tr -d ' ')

cat > dist/luminclaw-core.manifest.json <<EOF
{
  "version": "$VERSION",
  "minAppVersion": "1.0",
  "sha256": "$SHA256",
  "bytes": $RAW_BYTES,
  "gzipBytes": $GZIP_BYTES,
  "platform": "embedded"
}
EOF

echo ""
echo "Bundle:    $BUNDLE"
echo "Size:      $RAW_BYTES bytes"
echo "Gzipped:   $GZIP_BYTES bytes"
echo "Sha256:    $SHA256"
echo "Manifest:  dist/luminclaw-core.manifest.json"

if [ "$GZIP_BYTES" -gt 102400 ]; then
  echo ""
  echo "WARNING: gzip size $GZIP_BYTES exceeds 100KB target." >&2
fi
