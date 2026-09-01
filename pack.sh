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

# Only $EXT_DIR is packaged, so repo-root files (tests/, docs, pack.sh itself)
# are already out of scope. The extra excludes below are belt and braces in case
# anything ever lands inside the extension folder.
cd "$EXT_DIR"
zip -r "$OUTPUT" . \
    -x ".git/*" \
    -x ".DS_Store" \
    -x "*.map" \
    -x "Thumbs.db" \
    -x "tests/*" \
    -x "*__pycache__/*" \
    -x "*.pyc"

# Fail loudly rather than shipping a store build with test files in it.
if unzip -l "$OUTPUT" | grep -qE 'tests/|__pycache__|\.pyc'; then
    echo "Error: test files leaked into $OUTPUT" >&2
    exit 1
fi

echo ""
echo "Packaged: listen-carefully-v${VERSION}.zip"
echo "Size:     $(du -h "$OUTPUT" | cut -f1)"
