#!/usr/bin/env bash
set -euo pipefail

SERVER_HEALTH_URL="${SERVER_HEALTH_URL:-http://localhost:3001/health}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-12}"
SLEEP_SECONDS="${SLEEP_SECONDS:-5}"

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  echo "Checking deployment health ($attempt/$MAX_ATTEMPTS): $SERVER_HEALTH_URL"
  if curl --fail --silent --show-error "$SERVER_HEALTH_URL"; then
    echo ""
    echo "Deployment health check passed."
    exit 0
  fi
  sleep "$SLEEP_SECONDS"
done

echo "Deployment health check failed after $MAX_ATTEMPTS attempts." >&2
exit 1
