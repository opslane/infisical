#!/bin/sh
set -eu

PORT="${PORT:-8080}"
BASE="http://127.0.0.1:${PORT}"

# The server migrates the empty database on start, so the seed runs it in the background
# and creates the admin through the bootstrap API once it answers.
cd /backend
node --enable-source-maps dist/main.mjs > /tmp/seed-server.log 2>&1 &
server_pid=$!

i=0
until curl -fsS "${BASE}/api/status" > /dev/null 2>&1; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "server exited before becoming ready" >&2
    tail -n 100 /tmp/seed-server.log >&2
    exit 1
  fi
  i=$((i + 1))
  if [ "$i" -ge 150 ]; then
    echo "server not ready after 300s" >&2
    tail -n 100 /tmp/seed-server.log >&2
    kill "$server_pid" 2>/dev/null || true
    exit 1
  fi
  sleep 2
done

status=$(curl -sS -o /tmp/bootstrap.json -w '%{http_code}' \
  -X POST "${BASE}/api/v1/admin/bootstrap" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@opslane.local","password":"OpslaneVerify123!","organization":"Opslane Org"}')

kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true

if [ "$status" = "200" ]; then
  echo "seeded admin@opslane.local"
elif grep -q "already been set up" /tmp/bootstrap.json; then
  echo "instance already bootstrapped"
else
  echo "bootstrap failed with HTTP ${status}" >&2
  cat /tmp/bootstrap.json >&2
  exit 1
fi
