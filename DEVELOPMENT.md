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

## Email gateway (opt-in)

`apps/email-gateway` is a separate local process for the Gmail read-only
integration. It is deliberately off during normal dashboard development.
When enabled, `scripts/dev.sh` also allocates and prints `EMAIL_GATEWAY_PORT`.
The API and web retain their normal ports.

Create an ignored, owner-readable gateway file such as `.env.email-gateway`.
It is a strict `KEY=VALUE` configuration file, not a shell script: do not use
command substitutions, `export`, or shell quoting conventions that the gateway
does not support. Keep it out of the general dashboard `.env` and do not source
it into a Hermes or worker shell. Restrict it before starting the gateway:

```sh
touch .env.email-gateway
chmod 600 .env.email-gateway
```

```dotenv
# .env.email-gateway
EMAIL_GATEWAY_HOST=127.0.0.1
EMAIL_GATEWAY_ALLOWED_EMAIL=<your-authorized-gmail-address>
# Optional explicit directory owned by the gateway user, outside this repo.
# Defaults to $XDG_STATE_HOME/personal-dashboard-email-gateway or
# $HOME/.local/state/personal-dashboard-email-gateway.
# EMAIL_GATEWAY_DATA_DIR=/absolute/private/gateway-state
EMAIL_GATEWAY_TOKEN_ENCRYPTION_KEY=<base64-32-byte-key>
EMAIL_GATEWAY_ADMIN_TOKEN=<gateway-admin-token>
EMAIL_GATEWAY_CONSUMER_TOKEN=<scoped-dashboard-reader-token>
EMAIL_GATEWAY_OAUTH_CLIENT_ID=<oauth-client-id>
EMAIL_GATEWAY_OAUTH_CLIENT_SECRET=<oauth-client-secret>
# EMAIL_GATEWAY_OAUTH_REDIRECT_URI=<registered-loopback-callback>
# EMAIL_GATEWAY_PUBSUB_TOPIC=<pubsub-topic>
# EMAIL_GATEWAY_PUBSUB_AUDIENCE=<expected-push-audience>
# EMAIL_GATEWAY_PUBSUB_PUSH_SERVICE_ACCOUNT=<push-service-account>
EMAIL_GATEWAY_DASHBOARD_EVENT_TOKEN=<dashboard-event-token>
```

For automatic finance candidates, configure only issuer-specific parsers that
name their authenticated sending domains. A parser without
`authenticatedDomains` is intentionally ignored, even if its visible `From`
address matches. Keep this JSON on one `KEY=VALUE` line in the private file:

```dotenv
EMAIL_GATEWAY_TRANSACTION_PARSERS_JSON=[{"id":"issuer-notification.v1","senders":["alerts@issuer.example"],"authenticatedDomains":["issuer.example"],"amountPattern":"Amount: \\$([0-9.]+)","merchantPattern":"Merchant: ([A-Za-z ]+)","currency":"USD"}]
```

The gateway requires Gmail's first `Authentication-Results` header to report
`mx.google.com`, `dmarc=pass`, and an aligned configured domain before it emits
a pending finance candidate. Treat each candidate as preliminary until Plaid
reconciles it.

Do not put `EMAIL_GATEWAY_PORT` in this file: the launcher injects the
worktree-specific port. For local delivery, leave
`EMAIL_GATEWAY_DASHBOARD_EVENT_URL` unset and the gateway derives the dashboard
event endpoint from the local API URL. Set it explicitly only for a deliberate
remote deployment. If using an OAuth web client, register the exact loopback
callback URL for the allocated gateway port; a desktop loopback client can
avoid per-worktree callback registration when supported by its OAuth setup.

Start all three local processes with the two dashboard-side values supplied to
the launcher:

```sh
EMAIL_GATEWAY_ENABLED=true \
EMAIL_GATEWAY_ENV_FILE=.env.email-gateway \
EMAIL_GATEWAY_EVENT_TOKEN=<dashboard-event-token> \
EMAIL_GATEWAY_DASHBOARD_TOKEN=<scoped-dashboard-reader-token> \
PERSONAL_DASHBOARD_API_TOKEN=<dashboard-api-token> \
scripts/dev.sh
```

`EMAIL_GATEWAY_EVENT_TOKEN` must exactly match the private gateway file's
`EMAIL_GATEWAY_DASHBOARD_EVENT_TOKEN`. It authenticates gateway event delivery
to the dashboard API. `EMAIL_GATEWAY_DASHBOARD_TOKEN` must match
`EMAIL_GATEWAY_CONSUMER_TOKEN`; it is a scoped gateway-reader capability for
the dashboard API, not a Google credential. In local mode,
`EMAIL_GATEWAY_API_BASE_URL` defaults to the allocated loopback gateway URL;
set it only when intentionally targeting another gateway.
`PERSONAL_DASHBOARD_API_TOKEN` is required while the email gateway is enabled;
the API rejects search and read calls if it is absent. Use a distinct random
value from both gateway tokens.

The launcher runs the gateway with an otherwise empty environment and passes
only its config-file path, allocated port, and local dashboard API URL. It
does not shell-source the config file. API receives only the event receiver
token and scoped gateway-reader configuration; web receives neither. All
`GOOGLE_*`, `GMAIL_*`, and other gateway-only values are removed from dashboard
children. Hermes and separate workers are not given the private gateway file.

Grant the Google OAuth client only `gmail.readonly`. The gateway has no Gmail
write/delete capability, and no agent process receives the Google credential.
Use `scripts/stop-web.sh` to stop the optional gateway along with API and web.

For the initial OAuth connection, call the admin endpoint locally and open the
returned URL in a browser signed into the allowed account:

```sh
curl -sS -X POST "http://127.0.0.1:<gateway-port>/v1/oauth/start" \
  -H "Authorization: Bearer ${EMAIL_GATEWAY_ADMIN_TOKEN}"
```

For real-time notifications, Gmail watch publishes to Pub/Sub, and Pub/Sub must
reach `/v1/pubsub/push` through an authenticated HTTPS ingress. A loopback-only
development gateway cannot receive Google push traffic directly; deploy the
gateway behind a narrow HTTPS reverse proxy or run a separate authenticated
pull-subscription bridge. Renew the Gmail watch before it expires.

The local launcher prevents dashboard children from inheriting the gateway
secrets, but it is not an OS isolation boundary. Do not give Hermes shell or
filesystem access to the gateway's config/data. For a real connected mailbox,
run the gateway under a separate Unix user or container and keep its private
dotenv and encrypted state outside the agent-readable workspace.

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
- `EMAIL_GATEWAY_PORT`: deterministic, opt-in Gmail gateway port; set by
  `scripts/worktree_ports.py`, not by `.env`.
- `EMAIL_GATEWAY_ENABLED`: set to `true` only when launching the local gateway;
  it also requires `PERSONAL_DASHBOARD_API_TOKEN`.
- `EMAIL_GATEWAY_ENV_FILE`: ignored, gateway-only strict dotenv file; never
  source it as a shell file or put Google credentials in the general `.env`.
- `EMAIL_GATEWAY_DATA_DIR`: optional private state directory in the gateway-only
  file. It defaults to the gateway user's XDG state directory (or private home
  state path), not the repository.
- `EMAIL_GATEWAY_EVENT_TOKEN`: API-only receiver token for gateway events.
- `EMAIL_GATEWAY_DASHBOARD_TOKEN`: API-only scoped reader token for gateway
  searches; it is not a Google credential.
- `EMAIL_GATEWAY_API_BASE_URL`: optional gateway URL override. Local launcher
  defaults it to the allocated loopback gateway URL.
- `HERMES_WEBHOOK_SECRET`: optional shared secret for future Hermes webhook validation.
- `PERSONAL_DASHBOARD_API_TOKEN`: bearer token required by the Gmail proxy
  endpoints whenever `EMAIL_GATEWAY_ENABLED=true`, and by `/api/hermes/*`
  endpoints when configured.
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
contains the dashboard JSON store, Plaid access tokens, and coding-agent run
evidence. The image starts the worker through the API, so the API remains the
only writer for dashboard state.

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
- `GET /api/integrations/gmail-intake/status`: authenticated gateway status.
- `POST /api/integrations/gmail-intake/search`: authenticated structured,
  bounded Gmail search; raw Gmail query syntax is rejected.
- `POST /api/integrations/gmail-intake/messages/read`: authenticated
  receipt-bound sanitized text retrieval; attachments are unavailable.
- `GET /api/hermes/context`: compact context that Hermes can pull before acting.
- `GET /api/hermes/capabilities`: triggerable app capabilities exposed to Hermes.
- `POST /api/hermes/actions`: dashboard/Hermes action envelope for future dispatch.
- `POST /api/integrations/:source/events`: normalized event intake for
  `hotel-rate-finder`, `flight-searcher`, `asia-travel-deals`, and `plaid`.
  The `gmail-intake` route is reserved for the separately authenticated,
  versioned Gmail transaction event schema.

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
