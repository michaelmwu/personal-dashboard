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
- `OPENCLAW_API_BASE_URL`: optional future OpenClaw service URL.

## Framework Endpoints

- `GET /api/dashboard`: full fixture-backed dashboard contract.
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
