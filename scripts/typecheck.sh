#!/usr/bin/env sh
set -eu

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/personal-dashboard-typecheck.XXXXXX")"

bun build \
  apps/api/server.mjs \
  apps/web/server.mjs \
  scripts/dev.mjs \
  packages/contracts/index.mjs \
  packages/fixtures/dashboard.mjs \
  packages/integrations/coding-agent.mjs \
  packages/integrations/hermes-bridge.mjs \
  packages/integrations/hermes.mjs \
  packages/integrations/hotel-rates.mjs \
  packages/integrations/openclaw.mjs \
  packages/integrations/plaid.mjs \
  packages/integrations/registry.mjs \
  packages/integrations/sources.mjs \
  packages/storage/dashboard-store.mjs \
  scripts/integration-worker.mjs \
  tests/contracts.test.mjs \
  tests/dev_script.test.mjs \
  tests/worktree_ports.test.mjs \
  --target=bun \
  --outdir "$tmp_dir/bun"

bun build apps/web/src/app.js --target=browser --outdir "$tmp_dir/browser"
