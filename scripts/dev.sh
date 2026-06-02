#!/usr/bin/env sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
workspace="$(CDPATH= cd -- "$script_dir/.." && pwd -P)"
cd "$workspace"

if [ "$#" -ne 0 ]; then
  echo "usage: scripts/dev.sh" >&2
  exit 2
fi

eval "$(python3 scripts/worktree_ports.py export)"

if command -v lsof >/dev/null 2>&1; then
  scripts/stop-web.sh --no-force
fi

echo "Using worktree ports:"
python3 scripts/worktree_ports.py env
echo
echo "Personal Dashboard API: http://127.0.0.1:${API_PORT}"
echo "Personal Dashboard:     http://127.0.0.1:${WEB_PORT}"
echo

exec bun scripts/dev.mjs
