# Architecture

Personal Dashboard is a monorepo dashboard for personal spend, alerts, rewards, and agent-driven recommendations. The first version is deliberately small: it exposes stable contracts, realistic fixtures, and a runnable dashboard shell that can later be wired to Hermes, OpenClaw, Plaid, Gmail, Telegram, and Postgres.

## Goals

- Show the fast-path signal from Hermes: card alerts, suspicious transactions, duplicate charges, and reward estimates.
- Show the slow-path source of truth from future Plaid sync and reconciliation jobs.
- Surface OpenClaw tasks and recommendations next to the financial state they are meant to improve.
- Keep provider-specific parsing out of the UI and API route handlers.

## Monorepo Layout

```text
apps/
  api/          Bun-powered HTTP API and integration webhook receiver
  web/          Static dashboard frontend and local web server
packages/
  contracts/    Shared domain builders and dashboard contract shape
  fixtures/     Representative local development data
  integrations/ Hermes and OpenClaw adapter boundaries
scripts/        Conductor-aware dev, archive, port, and smoke-test scripts
```

## Runtime Shape

```text
Gmail / bank email
  -> Hermes
  -> apps/api /api/integrations/hermes/events
  -> packages/integrations/hermes
  -> packages/contracts
  -> apps/web dashboard

OpenClaw
  -> apps/api /api/dashboard
  -> packages/integrations/openclaw
  -> apps/web action surfaces
```

The API currently uses local fixtures. The boundary is intentional: replacing fixtures with real Hermes and OpenClaw clients should not require rewriting dashboard rendering code.

## Data Model

Core entities:

- `Transaction`: card spend, pending or posted.
- `Alert`: fast-path event from Hermes or another detector.
- `RewardInsight`: expected points, missed points, and card advice.
- `OpenClawTask`: agent task or recommendation to act on.
- `Metric`: summarized dashboard KPI.

The slow-path reconciliation system should stay narrow for now: pending-to-posted matching, merchant normalization, refund matching, transfer detection, and source-of-truth sync status.

## Integration Boundaries

Hermes adapters should translate incoming messages into normalized alerts and transaction candidates. The dashboard should not know whether a signal came from Gmail, Telegram, bank email, or a future webhook shape.

OpenClaw adapters should translate agent state into dashboard tasks, recommendations, and operational status. The dashboard should not depend on OpenClaw internals beyond the contract exported by `packages/integrations/openclaw`.

## Local Development

Development runs two local processes:

- API server on `API_PORT`.
- Web server on `WEB_PORT`.

`scripts/worktree_ports.py` derives stable ports per worktree and honors Conductor's `CONDUCTOR_PORT` range when present.
