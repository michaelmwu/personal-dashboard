# Architecture

Personal Dashboard is a monorepo dashboard for personal spend, travel, alerts, rewards, and agent-driven recommendations. The first version is deliberately small: it exposes stable contracts, realistic fixtures, and a runnable dashboard shell that can later be wired to Hermes, OpenClaw, Plaid, Gmail, Telegram, and Postgres.

## Goals

- Show the fast-path signal from Hermes: card alerts, suspicious transactions, duplicate charges, and reward estimates.
- Show the slow-path source of truth from future Plaid sync and reconciliation jobs.
- Track travel search state from hotel rate, Google Flights, Skyscanner, and Asia deal sources without baking scraper details into the UI.
- Parse Gmail into reservations, finance statements, and important intake items through normalized contracts.
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
  integrations/ Hermes, OpenClaw, travel, finance, and intake adapter boundaries
scripts/        Conductor-aware dev, archive, port, and smoke-test scripts
dashboard.config.yaml
                 Enabled app registry, panel order, and app manifest paths
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

apps/web dashboard
  -> apps/api /api/hermes/actions
  -> Hermes action envelope
  -> packages/integrations/sources
  -> hotel_rate_finder / flights-extension / asiatraveldeals / Plaid / Gmail

Hermes
  -> apps/api /api/hermes/context
  -> compact context for agent decisions

Hermes
  -> apps/api /api/hermes/actions
  -> dashboard-visible action queue
  -> future dispatcher into app adapters

hotel_rate_finder / flights-extension / asiatraveldeals
  -> packages/integrations/sources
  -> apps/api /api/integrations/:source/events
  -> apps/web travel surfaces

Plaid / Gmail
  -> packages/integrations/sources
  -> apps/api /api/integrations/:source/events
  -> apps/web finance, reservations, and intake surfaces

Plaid Link
  -> apps/api /api/integrations/plaid/link-token
  -> Plaid Link browser flow
  -> apps/api /api/integrations/plaid/exchange-public-token
  -> local ignored access-token/cursor store
  -> apps/api /api/integrations/plaid/sync
  -> packages/integrations/plaid
  -> apps/web finance and transaction surfaces

Manual hotel reservation / Gmail reservation
  -> apps/api /api/travel/reservations
  -> local ignored dashboard reservation store
  -> apps/api /api/integrations/hotel-rate-finder/sync
  -> packages/integrations/hotel-rates
  -> hotel_rate_finder FastAPI saved searches and jobs
  -> apps/web hotel watches and alerts

App manifest
  -> dashboard.config.yaml
  -> packages/integrations/registry
  -> apps/api /api/apps and /api/hermes/capabilities
  -> apps/web generic plugin panel summary
```

The API currently uses local fixtures. The boundary is intentional: replacing fixtures with real Hermes and OpenClaw clients should not require rewriting dashboard rendering code.

## Data Model

Core entities:

- `Transaction`: card spend, pending or posted.
- `Alert`: fast-path event from Hermes or another detector.
- `RewardInsight`: expected points, missed points, and card advice.
- `OpenClawTask`: agent task or recommendation to act on.
- `Metric`: summarized dashboard KPI.
- `HotelRateWatch`: property/date/rate target from hotel search.
- `FlightSearchWatch`: route/date/provider target from flight search.
- `TravelDeal`: reviewed or candidate deal from Asia deal ingestion.
- `Reservation`: parsed flight/hotel/travel confirmation.
- `FinanceAccount`: Plaid-backed account sync state.
- `IntakeItem`: classified Gmail item for review or automation.
- `HermesCapability`: action Hermes is allowed to trigger.
- `HermesAction`: versioned, idempotent, dashboard-visible request envelope for
  Hermes/app work.
- `AppManifest`, `AppPanel`, `AppItem`: lightweight plugin tier for enabled
  apps, generic panel declarations, and opaque app-specific payloads.

The slow-path reconciliation system should stay narrow for now: pending-to-posted matching, merchant normalization, refund matching, transfer detection, and source-of-truth sync status.

## Integration Boundaries

The dashboard uses a two-tier contract. Core shared types are small and blessed:
transactions, alerts, reservations, watches, feed items, metrics, and actions.
Cross-app joins and Hermes context should depend only on those core types.
Everything app-specific uses the generic item envelope
`{ app, type, externalId, ts, status, payload }` and is rendered by generic
panels or deep-linked to the owning app UI.

Each app declares itself with a `dashboard-manifest.json` contract:

- identity: app id, name, version, base URL or env-backed base URL
- panels: id, type, title, data source, default position
- capabilities: id, kind (`deterministic` or `agentic`), target, endpoint, input schema
- event types: app-specific item/event names accepted by the dashboard

`dashboard.config.yaml` decides which apps are enabled and panel order/position.
The current local manifests live under `packages/integrations/manifests/` as a
bootstrap; app-owned repos should eventually commit their own manifests and have
this config point at them.

Hermes adapters should translate incoming messages into normalized alerts and transaction candidates. The dashboard should not know whether a signal came from Gmail, Telegram, bank email, or a future webhook shape.

OpenClaw adapters should translate agent state into dashboard tasks, recommendations, and operational status. The dashboard should not depend on OpenClaw internals beyond the contract exported by `packages/integrations/openclaw`.

Travel and intake adapters should translate existing repo outputs into
contracts exported by `packages/integrations/sources`. The API accepts
placeholder event posts at `/api/integrations/:source/events`; persistence and
provider-specific clients can be added later without changing the web app.

`hotel_rate_finder` stays the owner of Hyatt/IHG scraping, stealth browser
runtime, saved searches, job status, cache TTL, provider errors, and raw rate
evidence. The dashboard client in `packages/integrations/hotel-rates.mjs` only
speaks the documented FastAPI agent API: create/reuse saved searches, run them,
poll jobs, and normalize completed reports. The watcher compares an active
refundable hotel reservation's paid rate against the cheapest cancellable rate
for the same room class when the scraper identifies room names; otherwise the
comparison is explicitly marked as the service's cheapest cancellable evidence.
Failed jobs and provider errors are alertable states.

Plaid is the first provider client. `packages/integrations/plaid` wraps the
official Plaid Node SDK for Link token creation, public-token exchange, and
cursor-based `/transactions/sync`. The dashboard stores Plaid access tokens and
cursors in the ignored local dashboard store for the personal-host bootstrap;
before multi-user or public deployment, replace that with encrypted storage.

Hermes integration is bidirectional:

- Dashboard-to-Hermes: the dashboard submits `origin: "dashboard"` action
  envelopes at `/api/hermes/actions`; the API dispatches agentic work to Hermes
  Bridge and streams run status back onto the stored action.
- Hermes-to-dashboard: Hermes reads `/api/hermes/context` before acting and can
  post source events back through `/api/integrations/:source/events`.
- Capability discovery: `/api/hermes/capabilities` folds over enabled app
  manifests. Disabling an app in `dashboard.config.yaml` removes its
  capabilities from Hermes. Deterministic capabilities route to declared
  endpoints; agentic capabilities route to Hermes Bridge with the existing
  origin loop guard.

When `PERSONAL_DASHBOARD_API_TOKEN` is configured, all `/api/hermes/*`
endpoints require a bearer token. Action envelopes include a contract version
and idempotency key. Hermes-originated envelopes use `origin: "hermes"` so the
dispatcher does not forward them back into Hermes.

## Local Development

Development runs two local processes:

- API server on `API_PORT`.
- Web server on `WEB_PORT`.

`scripts/worktree_ports.py` derives stable ports per worktree and honors Conductor's `CONDUCTOR_PORT` range when present.
