#!/usr/bin/env bash
set -Eeuo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a
source "$PROJECT_DIR/.env"
set +a
BACKEND_PORT="${BACKEND_PORT:-${PORT:-3000}}"
FRONTEND_PORT="${FRONTEND_PORT:-3001}"
export BACKEND_PORT FRONTEND_PORT
if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi
for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is occupied; no process was terminated." >&2
    exit 1
  fi
done
cd "$PROJECT_DIR"
exec node src/server.js
