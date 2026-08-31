# Development

## Requirements

- macOS or another Unix-like environment.
- Bun 1.3 or newer.
- `python3` for worktree port allocation.

## Setup

```sh
bun install --frozen-lockfile --ignore-scripts --minimum-release-age=604800
```

## Run

```sh
scripts/dev.sh
```

This starts:

- API: `http://127.0.0.1:${API_PORT}`
- Web: `http://127.0.0.1:${WEB_PORT}`

Outside Conductor, ports are derived from the worktree path. Inside Conductor, `CONDUCTOR_PORT` wins and the script uses the allocated ten-port range.

## Useful Commands

```sh
bun test
bun run smoke
bun run check
python3 scripts/worktree_ports.py env
scripts/stop-web.sh
scripts/archive-workspace.sh --dry-run
```

## Environment Variables

- `API_PORT`: API and integration receiver port.
- `WEB_PORT`: dashboard frontend port.
- `HERMES_WEBHOOK_SECRET`: optional shared secret for future Hermes webhook validation.
- `PERSONAL_DASHBOARD_API_TOKEN`: optional bearer token required by
  `/api/hermes/*` endpoints when configured.
- `PERSONAL_DASHBOARD_TAILSCALE_ALLOWED_LOGINS`: comma-separated Tailscale
  logins allowed to use the standalone web UI through Tailscale Serve. Leave
  unset for local development.
- `PERSONAL_DASHBOARD_TAILSCALE_ALLOWED_APP_CAPABILITIES`: comma-separated
  Tailscale app capabilities accepted from tagged service clients. This is for
  machine-to-machine access such as Hermes on a tagged Minibox; tagged devices
  do not receive `Tailscale-User-Login` headers.
- `OPENCLAW_API_BASE_URL`: optional future OpenClaw service URL.
- `HOUSE_CALENDAR_BASE_URL`: optional browser URL for the House Calendar
  dashboard porthole (for example, `https://house.michaelmwu.com`).
- `ASIA_TRAVEL_DEALS_WEBHOOK_TOKEN`: optional, dedicated bearer token accepted
  only by the Asia Travel Deals event webhook. Keep it separate from
  `PERSONAL_DASHBOARD_API_TOKEN`.

## Coolify Deployment

The production image runs the web UI, loopback API, and integration worker in
one private container. Attach one persistent Coolify volume at `/data`; it
contains the dashboard JSON store, encrypted Plaid access-token envelopes, and
coding-agent run evidence. Set `PLAID_TOKEN_ENCRYPTION_KEY` as a Coolify secret
before linking an account. The image starts the worker through the API, so the
API remains the only writer for dashboard state.

The standard deployment does not need PostgreSQL or Redis. Configure Coolify
to build the root `Dockerfile`, expose port `8811`, and use `/api/health` for
health checks. Do not assign an ingress domain until private access control is
in place.

For the standalone MooHQ UI, bind the Coolify host port to loopback and expose
it only with Tailscale Serve. Set
`PERSONAL_DASHBOARD_TAILSCALE_ALLOWED_LOGINS` to your Tailscale login (for
example, `michaelmwu@gmail.com`). Tailscale Serve strips spoofed identity
headers before adding its own, but the web service must remain loopback-only so
other tailnet peers cannot forge those headers by reaching it directly.

Tagged clients such as Hermes do not receive a user-login header. Grant them a
custom capability such as `michaelmwu.com/cap/moohq` in the tailnet policy,
set `PERSONAL_DASHBOARD_TAILSCALE_ALLOWED_APP_CAPABILITIES` to that capability,
and configure Serve to forward it:

```sh
sudo tailscale serve --bg --https=443 \
  --accept-app-caps=michaelmwu.com/cap/moohq \
  http://127.0.0.1:18811
```

The dashboard accepts either an allowed login or an allowed capability. Its
normal endpoint-specific API bearer tokens remain required for service actions.

Set integration endpoints as private service URLs and keep their tokens in
Coolify secret environment variables. For example, a dashboard on Coolify's
predefined Docker network can use `HOTEL_RATE_FINDER_API_BASE_URL` and
`ASIA_TRAVEL_DEALS_API_BASE_URL` to reach the respective private services.
Set `HOTEL_RATE_SYNC_ENABLED=true` to make the bundled worker refresh active
hotel reservations.

For inbound private webhooks, override `API_HOST=0.0.0.0` in Coolify while
leaving port `8810` without a public domain or Traefik route. The API remains
reachable only on the shared Docker network and requires its endpoint-specific
bearer token.

## Framework Endpoints

- `GET /api/dashboard`: full dashboard contract (fixtures are local-only by
  default; production starts empty until live data arrives).
- `GET /api/host-dashboard/overview`, `/hotel-rate-finder`, and
  `/asia-travel-deals`: bounded read-only `host-dashboard-viewport.v1`
  projections for the native Hermes plugin.
- `GET /api/integrations/catalog`: adapter roadmap and source repo mapping.
- `GET /api/travel`: travel watches, deal feed, and reservations.
- `GET /api/finance`: Plaid placeholder account sync surface.
- `GET /api/intake`: Gmail intake placeholder surface.
- `GET /api/hermes/context`: compact context that Hermes can pull before acting.
- `GET /api/hermes/capabilities`: triggerable app capabilities exposed to Hermes.
- `POST /api/hermes/actions`: dashboard/Hermes action envelope for future dispatch.
- `POST /api/integrations/:source/events`: normalized event intake for
  `hotel-rate-finder`, `flight-searcher`, `asia-travel-deals`, `plaid`, and
  `gmail-intake`.

When `PERSONAL_DASHBOARD_API_TOKEN` is set, call Hermes endpoints with:

```http
Authorization: Bearer <PERSONAL_DASHBOARD_API_TOKEN>
```

## Adding Real Integrations

1. Add provider-specific client code under `packages/integrations/`.
2. Keep provider payload normalization out of `apps/web`.
3. Preserve or intentionally migrate the dashboard response from `/api/dashboard`.
4. Add tests for payload mapping and degraded-service behavior.

## Conductor

The checked-in `conductor.json` configures:

- Setup: `bun install --frozen-lockfile --ignore-scripts --minimum-release-age=604800`
- Run: `scripts/dev.sh`
- Archive: `scripts/archive-workspace.sh`
- Run mode: `concurrent`

Multiple workspaces can run concurrently because ports are isolated per worktree.
