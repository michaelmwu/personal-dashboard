#!/usr/bin/env sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
script_workspace="$(CDPATH= cd -- "$script_dir/.." && pwd -P)"
workspace="${CONDUCTOR_WORKSPACE_PATH:-$script_workspace}"
workspace="$(CDPATH= cd -- "$workspace" && pwd -P)"

dry_run="${STOP_WEB_DRY_RUN:-0}"
force="${STOP_WEB_FORCE_KILL:-1}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --no-force)
      force=0
      shift
      ;;
    *)
      break
      ;;
  esac
done

if [ "$#" -ne 0 ]; then
  echo "usage: scripts/stop-web.sh [--dry-run] [--no-force]" >&2
  exit 2
fi

cd "$workspace"

if ! command -v lsof >/dev/null 2>&1; then
  echo "Missing required dependency: lsof. Refusing to kill processes without cwd verification." >&2
  exit 1
fi

eval "$(python3 scripts/worktree_ports.py export)"

log() {
  printf '%s\n' "$*"
}

run() {
  if [ "$dry_run" = "1" ]; then
    printf '[dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

process_command() {
  ps -p "$1" -o command= 2>/dev/null || true
}

process_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

process_parent() {
  ps -p "$1" -o ppid= 2>/dev/null | tr -d ' '
}

is_workspace_process() {
  pid="$1"
  depth=0

  while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null && [ "$depth" -lt 8 ]; do
    cwd="$(process_cwd "$pid")"
    case "$cwd" in
      "$workspace"|"$workspace"/*)
        return 0
        ;;
    esac
    pid="$(process_parent "$pid")"
    depth=$((depth + 1))
  done

  return 1
}

candidate_process_pids() {
  ps -axo pid=,command= | awk '
    /apps\/api\/server\.mjs/ ||
    /apps\/web\/server\.mjs/ ||
    /scripts\/dev\.mjs/ {
      print $1
    }
  '
}

candidate_port_pids() {
  for port in ${API_PORT:-} ${WEB_PORT:-}; do
    [ -n "$port" ] || continue
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
  done
}

workspace_pids() {
  {
    candidate_process_pids
    candidate_port_pids
  } | sort -u | while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    if is_workspace_process "$pid"; then
      printf '%s\n' "$pid"
    fi
  done
}

terminate_pids() {
  signal="$1"
  pids="$2"
  [ -n "$pids" ] || return 0

  for pid in $pids; do
    command="$(process_command "$pid")"
    if is_workspace_process "$pid"; then
      log "Sending $signal to pid $pid: $command"
      run kill "-$signal" "$pid" 2>/dev/null || true
    fi
  done
}

wait_for_exit() {
  pids="$1"
  attempts=0
  [ -n "$pids" ] || return 0

  while [ "$attempts" -lt 20 ]; do
    remaining=""
    for pid in $pids; do
      if kill -0 "$pid" 2>/dev/null && is_workspace_process "$pid"; then
        remaining="${remaining}${remaining:+ }${pid}"
      fi
    done
    [ -z "$remaining" ] && return 0
    attempts=$((attempts + 1))
    sleep 0.25
  done

  return 1
}

pids="$(workspace_pids)"

if [ -n "$pids" ]; then
  terminate_pids TERM "$pids"
  if [ "$dry_run" != "1" ] && ! wait_for_exit "$pids" && [ "$force" = "1" ]; then
    terminate_pids KILL "$(workspace_pids)"
  fi
else
  log "No matching workspace web processes found."
fi
