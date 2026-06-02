#!/usr/bin/env sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
workspace="$(CDPATH= cd -- "$script_dir/.." && pwd -P)"
cd "$workspace"

dry_run="${ARCHIVE_DRY_RUN:-0}"
force_flag=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --no-force)
      force_flag="--no-force"
      shift
      ;;
    *)
      break
      ;;
  esac
done

if [ "$#" -ne 0 ]; then
  echo "usage: scripts/archive-workspace.sh [--dry-run] [--no-force]" >&2
  exit 2
fi

stop_args=""
if [ "$dry_run" = "1" ]; then
  stop_args="--dry-run"
fi
if [ -n "$force_flag" ]; then
  stop_args="${stop_args}${stop_args:+ }${force_flag}"
fi

# shellcheck disable=SC2086
scripts/stop-web.sh $stop_args

printf '%s\n' "Workspace archive cleanup complete."
