#!/usr/bin/env sh
set -eu

./scripts/format.sh --check
./scripts/lint.sh
./scripts/typecheck.sh
./scripts/test.sh
