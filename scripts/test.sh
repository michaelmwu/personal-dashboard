#!/usr/bin/env sh
set -eu

bun test tests/*.test.mjs
bun run test:e2e
