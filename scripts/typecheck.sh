#!/usr/bin/env sh
set -eu

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/personal-dashboard-typecheck.XXXXXX")"

bun build \
  apps/api/server.mjs \
  apps/web/server.mjs \
  scripts/dev.mjs \
  packages/contracts/index.mjs \
  packages/fixtures/dashboard.mjs \
  packages/integrations/hermes.mjs \
  packages/integrations/openclaw.mjs \
  tests/contracts.test.mjs \
  --target=bun \
  --outdir "$tmp_dir/bun"

bun build apps/web/src/app.js --target=browser --outdir "$tmp_dir/browser"
