#!/usr/bin/env sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
workspace="$(CDPATH= cd -- "$script_dir/.." && pwd -P)"
cd "$workspace"

eval "$(python3 scripts/worktree_ports.py export)"

if ! command -v curl >/dev/null 2>&1; then
  echo "Missing required dependency: curl" >&2
  exit 1
fi

curl --fail --silent "http://127.0.0.1:${API_PORT}/api/health" >/dev/null
curl --fail --silent "http://127.0.0.1:${API_PORT}/api/dashboard" >/dev/null
curl --fail --silent "http://127.0.0.1:${WEB_PORT}/" >/dev/null

echo "Smoke test passed."
