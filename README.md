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
- `dashboard.config.yaml`: enabled app registry and panel ordering.

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
- Flight watches from a future `~/dev/flight-searcher` service that owns
  Playwright/cloakbrowser search execution.
- Asia deal candidates from `~/dev/asiatraveldeals`.
- Plaid account/transaction sync through the official Plaid Node SDK.
- Gmail intake for reservations, statements, and important email.

These are fixture-backed today. Real provider code should land in
`packages/integrations/` first, then flow through `/api/dashboard` without
provider-specific parsing in the web app.

Plugin-facing endpoints:

- `GET /api/apps`: enabled app manifests and configured panels from
  `dashboard.config.yaml`.
- `GET /api/apps/:appId/items?type=...`: generic app-specific items projected
  from core dashboard state plus opaque app events.
- `POST /api/apps/:appId/events`: generic event envelope for app-specific
  payloads that do not need a blessed core dashboard type.

Apps should declare `dashboard-manifest.json` files with panels, event types,
and Hermes capabilities. The dashboard keeps a small blessed set of core types
for cross-app joins, while app-specific details ride as opaque item payloads and
can deep-link back to the owning app.

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

Coding Agent endpoints:

- `GET /api/apps/coding-agent/tasks`: list active coding tasks. Pass
  `includeArchived=true` to include archived records.
- `POST /api/apps/coding-agent/tasks`: register the durable task anchor
  `{id, repo, branch, worktreeDir, hermesSessionKey, prNumber, previewUrl}`.
- `POST /api/apps/coding-agent/queue`: append typed work items to a task queue.
- `POST /api/apps/coding-agent/pr-status`: sync PR review/check/preview status
  onto a registered task.
- `POST /api/apps/coding-agent/pr-maintenance`: deterministically plan PR
  maintenance after enforcing repo allowlists, branch policy, PR-only rules, and
  side-effect approval requirements.
- `POST /api/apps/coding-agent/archive`: archive a completed or abandoned task
  and its remaining queue items.

Set `CODING_AGENT_ALLOWED_REPOS` to a comma-separated repo allowlist when
enforcing PR-maintenance repo policy. `CODING_AGENT_BRANCH_PREFIX` defaults to
`hermes`, and side-effecting maintenance actions such as push, PR creation,
merge, cleanup, and PR replies require `approvedBy` plus `approvalId`.

Set `CODING_AGENT_PR_POLL_ENABLED=true` on the integration worker to poll active
coding-task PRs with `gh api`. The poller reads `pr-open`,
`changes-requested`, and `waiting-for-approval` tasks, advances the task's
GitHub cursor through `/api/apps/coding-agent/pr-status`, and dispatches the
agentic `update-coding-task` capability only when new actionable reviews,
comments, or failed checks are found. Use `CODING_AGENT_GITHUB_OWNER` when task
records store repo names without an owner.

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

Hotel Rate Finder endpoints:

- `POST /api/travel/reservations`: upsert a manual hotel reservation with
  confirmation number, paid rate/currency, room class, cancellation policy, and
  Hyatt/IHG property metadata.
- `POST /api/integrations/hotel-rate-finder/sync`: ensure each active
  refundable Hyatt/IHG hotel reservation has a saved search in
  `hotel_rate_finder`, run it through the service's agent API, poll the job,
  and snapshot the cheapest cancellable comparable rate into travel watches.

Set `HOTEL_RATE_FINDER_API_BASE_URL` to the local or tailnet FastAPI service.
The dashboard never imports provider internals or runs browser scrapes; failed
or stale hotel jobs become dashboard alerts so a broken scraper does not look
like "no price drop."
