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
allocated_email_gateway_port="$EMAIL_GATEWAY_PORT"

if [ "${EMAIL_GATEWAY_EVENT_TOKEN+x}" = "x" ]; then
  dashboard_event_token_set=1
  dashboard_event_token="$EMAIL_GATEWAY_EVENT_TOKEN"
else
  dashboard_event_token_set=0
  dashboard_event_token=""
fi

if [ "${EMAIL_GATEWAY_API_BASE_URL+x}" = "x" ]; then
  dashboard_gateway_api_base_url_set=1
  dashboard_gateway_api_base_url="$EMAIL_GATEWAY_API_BASE_URL"
else
  dashboard_gateway_api_base_url_set=0
  dashboard_gateway_api_base_url=""
fi

if [ "${EMAIL_GATEWAY_DASHBOARD_TOKEN+x}" = "x" ]; then
  dashboard_gateway_token_set=1
  dashboard_gateway_token="$EMAIL_GATEWAY_DASHBOARD_TOKEN"
else
  dashboard_gateway_token_set=0
  dashboard_gateway_token=""
fi

gateway_enabled="${EMAIL_GATEWAY_ENABLED:-false}"
case "$gateway_enabled" in
  true|1)
    gateway_enabled=1
    ;;
  false|0|"")
    gateway_enabled=0
    ;;
  *)
    echo "EMAIL_GATEWAY_ENABLED must be true or false" >&2
    exit 2
    ;;
esac

scrub_email_gateway_environment() {
  for name in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p'); do
    case "$name" in
      EMAIL_GATEWAY_*|GOOGLE_*|GMAIL_*)
        unset "$name"
        ;;
    esac
  done
}

if command -v lsof >/dev/null 2>&1; then
  scripts/stop-web.sh --no-force
fi

echo "Using worktree ports:"
python3 scripts/worktree_ports.py env
echo
echo "Personal Dashboard API: http://127.0.0.1:${API_PORT}"
echo "Personal Dashboard:     http://127.0.0.1:${WEB_PORT}"
if [ "$gateway_enabled" = "1" ]; then
  echo "Email gateway:          http://127.0.0.1:${EMAIL_GATEWAY_PORT}"
fi
echo

if [ "$gateway_enabled" = "0" ]; then
  # API and web do not receive any Gmail or email-gateway environment values.
  # The gateway receiver token is unnecessary until the gateway is running.
  (
    scrub_email_gateway_environment
    exec bun scripts/dev.mjs
  )
  exit $?
fi

if [ "$dashboard_event_token_set" != "1" ] || [ -z "$dashboard_event_token" ]; then
  echo "EMAIL_GATEWAY_EVENT_TOKEN must be set when EMAIL_GATEWAY_ENABLED=true" >&2
  exit 2
fi
if [ "$dashboard_gateway_token_set" != "1" ] || [ -z "$dashboard_gateway_token" ]; then
  echo "EMAIL_GATEWAY_DASHBOARD_TOKEN must be set when EMAIL_GATEWAY_ENABLED=true" >&2
  exit 2
fi
if [ -z "${PERSONAL_DASHBOARD_API_TOKEN:-}" ]; then
  echo "PERSONAL_DASHBOARD_API_TOKEN must be set when EMAIL_GATEWAY_ENABLED=true" >&2
  exit 2
fi

gateway_env_file="${EMAIL_GATEWAY_ENV_FILE:-}"
if [ -z "$gateway_env_file" ]; then
  echo "EMAIL_GATEWAY_ENV_FILE must name a gateway-only dotenv file when EMAIL_GATEWAY_ENABLED=true" >&2
  exit 2
fi
case "$gateway_env_file" in
  /*)
    ;;
  *)
    gateway_env_file="$workspace/$gateway_env_file"
    ;;
esac
if [ ! -f "$gateway_env_file" ]; then
  echo "EMAIL_GATEWAY_ENV_FILE does not exist: $gateway_env_file" >&2
  exit 2
fi

if ! bun_bin="$(command -v bun)"; then
  echo "Missing required dependency: bun" >&2
  exit 1
fi

start_api() {
  (
    scrub_email_gateway_environment
    export EMAIL_GATEWAY_EVENT_TOKEN="$dashboard_event_token"
    if [ "$dashboard_gateway_api_base_url_set" = "1" ]; then
      export EMAIL_GATEWAY_API_BASE_URL="$dashboard_gateway_api_base_url"
    else
      export EMAIL_GATEWAY_API_BASE_URL="http://127.0.0.1:${allocated_email_gateway_port}"
    fi
    if [ "$dashboard_gateway_token_set" = "1" ]; then
      export EMAIL_GATEWAY_DASHBOARD_TOKEN="$dashboard_gateway_token"
    fi
    exec "$bun_bin" apps/api/server.mjs
  ) &
  api_pid=$!
}

start_web() {
  (
    scrub_email_gateway_environment
    # The web proxy forwards a caller's Authorization header; it never needs
    # the dashboard bearer credential in its own process environment.
    unset PERSONAL_DASHBOARD_API_TOKEN
    exec "$bun_bin" apps/web/server.mjs
  ) &
  web_pid=$!
}

start_email_gateway() {
  # Start from an empty environment and pass the dotenv path only to the
  # gateway. The gateway parses strict KEY=VALUE lines itself; this script
  # never sources credential-bearing files as shell code.
  env -i \
    PATH="$PATH" \
    HOME="${HOME:-}" \
    TMPDIR="${TMPDIR:-}" \
    EMAIL_GATEWAY_ENABLED=true \
    EMAIL_GATEWAY_ENV_FILE="$gateway_env_file" \
    EMAIL_GATEWAY_PORT="$EMAIL_GATEWAY_PORT" \
    PERSONAL_DASHBOARD_API_BASE_URL="$PERSONAL_DASHBOARD_API_BASE_URL" \
    "$bun_bin" apps/email-gateway/server.mjs &
  email_gateway_pid=$!
}

process_is_running() {
  process_state="$(ps -p "$1" -o stat= 2>/dev/null | tr -d '[:space:]')"
  [ -n "$process_state" ] && case "$process_state" in
    Z*) return 1 ;;
    *) return 0 ;;
  esac
}

cleanup() {
  trap - EXIT
  for pid in "${api_pid:-}" "${web_pid:-}" "${email_gateway_pid:-}"; do
    [ -n "$pid" ] || continue
    if process_is_running "$pid"; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  attempts=0
  while [ "$attempts" -lt 10 ]; do
    remaining=0
    for pid in "${api_pid:-}" "${web_pid:-}" "${email_gateway_pid:-}"; do
      [ -n "$pid" ] || continue
      if process_is_running "$pid"; then
        remaining=1
      fi
    done
    [ "$remaining" = "0" ] && break
    attempts=$((attempts + 1))
    sleep 0.1
  done
  if [ "$remaining" = "1" ]; then
    for pid in "${api_pid:-}" "${web_pid:-}" "${email_gateway_pid:-}"; do
      [ -n "$pid" ] || continue
      if process_is_running "$pid"; then
        kill -KILL "$pid" 2>/dev/null || true
      fi
    done
  fi
  for pid in "${api_pid:-}" "${web_pid:-}" "${email_gateway_pid:-}"; do
    [ -n "$pid" ] || continue
    wait "$pid" 2>/dev/null || true
  done
}

wait_for_service_exit() {
  while :; do
    for service in api web email-gateway; do
      case "$service" in
        api) pid="$api_pid" ;;
        web) pid="$web_pid" ;;
        email-gateway) pid="$email_gateway_pid" ;;
      esac
      if ! process_is_running "$pid"; then
        if wait "$pid"; then
          service_status=0
        else
          service_status=$?
        fi
        echo "[$service] exited with $service_status" >&2
        return "$service_status"
      fi
    done
    sleep 0.2
  done
}

start_api
start_web
start_email_gateway

trap 'exit_status=$?; cleanup; exit "$exit_status"' EXIT
trap 'exit 0' INT TERM HUP

if wait_for_service_exit; then
  exit_code=0
else
  exit_code=$?
fi
exit "$exit_code"
