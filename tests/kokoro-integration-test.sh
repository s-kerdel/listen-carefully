#!/bin/bash
#
# Spins up a throwaway Kokoro-FastAPI container, asserts that every endpoint the
# extension depends on still behaves, then tears it down.
#
# Isolation: the container gets a random free high port, a unique name, and --rm.
# It never binds 8880 and never touches containers, volumes or networks you
# already have running. Your own Kokoro server keeps working throughout.
#
# Usage:
#   tests/kokoro-integration-test.sh              # pull latest, test, tear down
#   tests/kokoro-integration-test.sh --keep       # leave the container running
#   tests/kokoro-integration-test.sh --no-pull    # use the local image as-is
#   tests/kokoro-integration-test.sh --url URL    # skip docker, test a running server
#
#   IMAGE=ghcr.io/remsky/kokoro-fastapi-cpu:v0.8.1 tests/kokoro-integration-test.sh
#
# Exit code 0 means the contract holds.

set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/remsky/kokoro-fastapi-cpu:latest}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECKS="$SCRIPT_DIR/kokoro_integration_checks.py"
READY_TIMEOUT="${READY_TIMEOUT:-300}"

KEEP=0
PULL=1
EXTERNAL_URL=""

while [ $# -gt 0 ]; do
    case "$1" in
        --keep)    KEEP=1; shift ;;
        --no-pull) PULL=0; shift ;;
        --url)     EXTERNAL_URL="${2:-}"; shift 2 ;;
        -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

if [ ! -f "$CHECKS" ]; then
    echo "Error: $CHECKS not found" >&2
    exit 1
fi

# Testing a server that is already up needs no docker at all.
if [ -n "$EXTERNAL_URL" ]; then
    echo "Testing existing server at $EXTERNAL_URL"
    exec python3 "$CHECKS" "$EXTERNAL_URL"
fi

command -v docker >/dev/null || { echo "Error: docker not found" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Error: docker daemon not reachable" >&2; exit 1; }

# A free ephemeral port, so we never collide with the 8880 you already use.
PORT="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"

if [ "$PORT" = "8880" ]; then
    echo "Error: refusing to bind 8880" >&2
    exit 1
fi

NAME="lc-kokoro-integration-$$"
BASE="http://127.0.0.1:$PORT"

cleanup() {
    local code=$?
    if [ "$KEEP" = "1" ]; then
        echo ""
        echo "Container left running as requested:"
        echo "  name: $NAME"
        echo "  url:  $BASE"
        echo "  stop: docker rm -f $NAME"
    else
        echo ""
        echo "Removing container $NAME"
        docker rm -f "$NAME" >/dev/null 2>&1 || true
    fi
    exit $code
}
trap cleanup EXIT INT TERM

echo "Image: $IMAGE"

if [ "$PULL" = "1" ]; then
    echo "Pulling (this can take a while on first run)..."
    docker pull "$IMAGE"
fi

echo "Starting throwaway container $NAME on 127.0.0.1:$PORT"
docker run -d --rm \
    --name "$NAME" \
    -p "127.0.0.1:$PORT:8880" \
    "$IMAGE" >/dev/null

echo -n "Waiting for the server to come up"
elapsed=0
until curl -sf -o /dev/null --max-time 3 "$BASE/health"; do
    if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
        echo ""
        echo "Error: container exited before becoming ready. Last output:" >&2
        docker logs "$NAME" 2>&1 | tail -30 >&2 || true
        exit 1
    fi
    if [ "$elapsed" -ge "$READY_TIMEOUT" ]; then
        echo ""
        echo "Error: not ready after ${READY_TIMEOUT}s. Last output:" >&2
        docker logs "$NAME" 2>&1 | tail -30 >&2
        exit 1
    fi
    echo -n "."
    sleep 3
    elapsed=$((elapsed + 3))
done
echo " ready in ${elapsed}s"

# Record what we actually tested, so a failure report names the exact build.
VERSION="$(curl -s --max-time 5 "$BASE/health" || true)"
echo "Server /health: $VERSION"

python3 "$CHECKS" "$BASE"
