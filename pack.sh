#!/bin/bash
#
# Packages the Listen Carefully extension into a zip file
# prepared for upload to the Chrome Web Store.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$SCRIPT_DIR/listen-carefully"
MANIFEST="$EXT_DIR/manifest.json"

if [ ! -f "$MANIFEST" ]; then
    echo "Error: manifest.json not found in $EXT_DIR"
    exit 1
fi

VERSION=$(grep -o '"version": *"[^"]*"' "$MANIFEST" | head -1 | grep -o '"[^"]*"$' | tr -d '"')

if [ -z "$VERSION" ]; then
    echo "Error: could not read version from manifest.json"
    exit 1
fi

OUTPUT="$SCRIPT_DIR/listen-carefully-v${VERSION}.zip"

if [ -f "$OUTPUT" ]; then
    rm "$OUTPUT"
fi

cd "$EXT_DIR"
zip -r "$OUTPUT" . \
    -x ".git/*" \
    -x ".DS_Store" \
    -x "*.map" \
    -x "Thumbs.db"

echo ""
echo "Packaged: listen-carefully-v${VERSION}.zip"
echo "Size:     $(du -h "$OUTPUT" | cut -f1)"
