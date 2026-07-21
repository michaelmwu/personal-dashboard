# Personal Dashboard Hermes Dashboard adapter

This is a trusted, read-only [Hermes Dashboard plugin](https://hermes-agent.nousresearch.com/docs/user-guide/features/extending-the-dashboard). It renders the stable `GET /api/host-dashboard/summary` contract as a native Hermes tab; it does not embed the standalone dashboard and it exposes no mutations.

## Install

Copy this directory to the normal Hermes plugin location, preserving the nested
`dashboard/` directory:

```sh
plugin_dir="${HERMES_HOME:-$HOME/.hermes}/plugins/personal-dashboard"
mkdir -p "$plugin_dir"
cp -R adapters/hermes-dashboard/. "$plugin_dir/"
```

Set `PERSONAL_DASHBOARD_PLUGIN_API_BASE_URL` in the environment of `hermes dashboard` only when the dashboard API is not on its default `http://127.0.0.1:8810` origin. The adapter accepts only literal loopback addresses (or `localhost`), an `http`/`https` scheme, and an origin with no path, query, credentials, or fragment. It always appends `/api/host-dashboard/summary` itself.

Restart `hermes dashboard` after installation because Hermes mounts plugin API
routes at startup. A UI-only rescan is not enough for `plugin_api.py`.

## Security boundary

Hermes Dashboard authenticates the browser session. Its JavaScript calls the
same-origin plugin route through `SDK.fetchJSON`; `plugin_api.py` then makes a
new fixed loopback request with only `Accept` and `User-Agent` headers. Browser
cookies, Authorization headers, and a dashboard API token are never relayed to
the Personal Dashboard service.

The adapter validates the minimum host-summary shape before returning it:
`version`, `generatedAt`, `health`, `metrics`, `alerts`, `travel`, and `tasks`.
If the local service is unavailable or returns an invalid response, it reports a
sanitized 502/503 error rather than leaking its URL, headers, or response body.

`plugin.yaml` and `__init__.py` are intentionally an enabled no-op Hermes plugin
shell. They make the directory usable by the normal Hermes plugin discovery
flow without adding agent tools or hooks.
