# Decisions

Last reviewed: 2026-06-03

## Bun Is The JavaScript Runtime And Package Manager

Use Bun for installs, scripts, tests, and local app processes.

Why: this is a new JavaScript monorepo and Bun keeps the development loop simple. `bunfig.toml` enforces the seven-day dependency cooldown from the 508 devkit convention.

Deviate when: the workspace grows large enough to need pnpm-specific monorepo behavior. Document that migration before changing package managers.

## Host-Run Apps With Deterministic Worktree Ports

Run the API and web dashboard on the host through `scripts/dev.sh`.

Why: Conductor workspaces and sibling worktrees need concurrent local servers without hand-edited env files. `scripts/worktree_ports.py` honors `CONDUCTOR_PORT` when available and otherwise hashes the worktree path.

Deviate when: deployment parity requires full-container development. Keep host-run scripts for normal agent and human development unless they become actively misleading.

## Keep Hermes And OpenClaw Behind Adapter Boundaries

Provider-specific Hermes and OpenClaw code belongs under `packages/integrations/`; dashboard contracts belong under `packages/contracts/`.

Why: the dashboard should not depend on bank-email parsing, Telegram delivery, OpenClaw internals, or future provider-specific payload details.

Deviate when: an integration contract has stabilized enough to graduate into a shared API package. Record the migration here.

## `.context/` Is Operational Memory

Use `.context/` for workspace-local architecture notes, decisions, failures, runbooks, summaries, screenshots, and handoff state.

Why: this repo is expected to be developed with multiple agents and Conductor workspaces.

Deviate when: information is user-facing or contributor-facing. Put that in README, DEVELOPMENT, ARCHITECTURE, or other project docs instead.
