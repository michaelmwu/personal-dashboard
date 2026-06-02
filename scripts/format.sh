#!/usr/bin/env sh
set -eu

mode="write"
if [ "${1:-}" = "--check" ]; then
  mode="check"
  shift
fi

if [ "$#" -ne 0 ]; then
  echo "usage: scripts/format.sh [--check]" >&2
  exit 2
fi

if [ "$mode" = "check" ]; then
  exec bun run format:check
fi

exec bun run format
