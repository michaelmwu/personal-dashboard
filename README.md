# Personal Dashboard

Personal Dashboard is a monorepo for spend awareness, reward optimization, and agent-driven follow-up. It is designed to integrate with Hermes for fast transaction alerts and OpenClaw for recommendations, tasks, and operational workflows.

The dashboard is the context and control plane. Hermes can pull dashboard
context, see available capabilities, and submit action envelopes that later
dispatch into the source apps.

The first version is runnable with local fixtures. It models the dashboard you described: fast bank-email signals, slow source-of-truth transaction state, reward calculations, suspicious charge alerts, and OpenClaw actions in one place.

## What Is Included

- `apps/api`: local JSON API and future integration webhook receiver.
- `apps/web`: dashboard UI served from a separate local web port.
- `packages/contracts`: shared dashboard contract builders.
- `packages/integrations`: Hermes, OpenClaw, travel, finance, and intake adapter boundaries.
- `packages/fixtures`: realistic development data.
- `scripts/`: Conductor-aware worktree ports, dev launch, archive, stop, and smoke-test scripts.

## Quick Start

```sh
bun install --frozen-lockfile --ignore-scripts --minimum-release-age=604800
scripts/dev.sh
```

Then open the dashboard URL printed by the dev script.

## Verify

```sh
bun test
bun run smoke
bun run check
```

## Documentation

- [Architecture](ARCHITECTURE.md)
- [Development](DEVELOPMENT.md)
- [Contributing](CONTRIBUTING.md)
- [Agent Instructions](AGENTS.md)
- [Supply Chain Policy](docs/supply-chain.md)
- [GitHub Workflows](docs/github-workflows.md)

## Integration Framework

The dashboard now has placeholder contracts for the next personal surfaces:

- Hotel rate watches from `~/dev/hotel_rate_finder`.
- Flight searches from `~/dev/flights-extension` for Google Flights and Skyscanner.
- Asia deal candidates from `~/dev/asiatraveldeals`.
- Plaid account/transaction sync through the official Plaid Node SDK.
- Gmail intake for reservations, statements, and important email.

These are fixture-backed today. Real provider code should land in
`packages/integrations/` first, then flow through `/api/dashboard` without
provider-specific parsing in the web app.

Hermes-facing endpoints:

- `GET /api/hermes/context`: compact dashboard context for agent prompts.
- `GET /api/hermes/capabilities`: actions Hermes is allowed to trigger.
- `POST /api/hermes/actions`: normalized action envelope. Hermes-originated
  envelopes are kept in the dashboard queue; dashboard-originated envelopes can
  dispatch to Hermes Bridge when `HERMES_BRIDGE_URL` and
  `HERMES_BRIDGE_PASSWORD` are configured.

Set `PERSONAL_DASHBOARD_API_TOKEN` to require `Authorization: Bearer ...` on
the Hermes endpoints. The Bridge password stays server-side in the API process;
it must never be sent to the web client.

Plaid-facing endpoints:

- `POST /api/integrations/plaid/link-token`: create a Plaid Link token for the
  browser Link flow.
- `POST /api/integrations/plaid/exchange-public-token`: exchange Link's
  `public_token` for an access token and store it in the ignored local
  dashboard store.
- `POST /api/integrations/plaid/sync`: run deterministic `/transactions/sync`
  for linked Items and upsert accounts/transactions into the dashboard.
- `POST /api/integrations/plaid/webhook`: accept Plaid transaction webhooks and
  trigger sync on `SYNC_UPDATES_AVAILABLE`.

Set `PLAID_CLIENT_ID`, `PLAID_SECRET`, and `PLAID_ENV`. The access token store
is local ignored data for now; move it behind encrypted storage before using
this outside a personal trusted host.
