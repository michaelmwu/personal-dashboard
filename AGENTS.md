# Agent Instructions

This repository is a JavaScript monorepo for a personal finance and rewards dashboard intended to integrate with Hermes and OpenClaw.

## Environment

- Use `python3`; do not assume `python` exists.
- Prefer the checked-in scripts under `scripts/` for local development.
- Treat `.context/` as workspace-local operational memory. Do not commit it.

## Local Workflow

- Setup: `bun install --frozen-lockfile --ignore-scripts --minimum-release-age=604800`
- Dev server: `scripts/dev.sh`
- Tests: `bun test`
- Full check: `bun run check`
- Stop local dev processes: `scripts/stop-web.sh`

Conductor workspaces should use `conductor.json`. `CONDUCTOR_PORT` is honored by `scripts/worktree_ports.py` and allocates:

- `API_PORT`: JSON API and integration webhook receiver.
- `WEB_PORT`: dashboard frontend.

## Architecture Guardrails

- Keep Hermes and OpenClaw integrations behind package boundaries in `packages/integrations/`.
- Keep domain contracts in `packages/contracts/`.
- Do not let app code depend on email/provider-specific parsing details directly.
- Add real provider clients as adapters, preserving the current dashboard API shape where possible.
- Prefer small fixtures and focused contract tests over broad snapshot tests.

## Dependency Safety

This scaffold has no third-party runtime dependencies. If dependencies are added:

- Keep committed lockfiles current.
- Use locked installs in CI and setup scripts.
- Preserve `bunfig.toml` supply-chain cooldown behavior where supported.
- Inspect package scripts before adding new install-time hooks.
