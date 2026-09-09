# Personal Dashboard Hermes Dashboard adapter

This trusted [Hermes Dashboard plugin](https://hermes-agent.nousresearch.com/docs/user-guide/features/extending-the-dashboard) renders native Overview, Hotel Rate Finder, Asia Travel Deals, and Award Flights tabs. Award Flights polls recent searches, shows each provider independently, and submits CAPTCHA or OTP responses without passing their values through chat or the language model.

## Install

Copy this directory to the normal Hermes plugin location, preserving the nested
`dashboard/` directory:

```sh
plugin_dir="${HERMES_HOME:-$HOME/.hermes}/plugins/personal-dashboard"
mkdir -p "$plugin_dir"
cp -R adapters/hermes-dashboard/. "$plugin_dir/"
```

Set `PERSONAL_DASHBOARD_PLUGIN_API_BASE_URL` in the environment of `hermes
dashboard` only when the dashboard API is not on its default
`http://127.0.0.1:8810` origin. The adapter accepts only literal loopback
addresses (or `localhost`) and appends fixed host paths itself.

Award Flights additionally requires a systemd credential named
`personal-dashboard-flight-intervention-token`. Deployment derives it from the
existing dashboard API token with a fixed v1 label. Do not put the general
dashboard token or a 1Password service-account token in the Hermes Dashboard
process.

Restart `hermes dashboard` after installation because Hermes mounts plugin API
routes at startup. A UI-only rescan is not enough for `plugin_api.py`.

## Security boundary

Hermes Dashboard authenticates the browser session. Its JavaScript calls the
same-origin plugin route through `SDK.fetchJSON`; `plugin_api.py` then makes a
new fixed loopback request. Browser cookies and Authorization headers are never
relayed. Read-only requests carry no credential; award-flight routes carry only
the systemd-supplied flight-intervention credential.

Challenge values exist only in browser form state long enough to send one
direct request. The proxy and dashboard API do not echo them. This plugin does
not read email. Browser handoffs open the full Award Flights dashboard because
arbitrary browser control is outside this narrow authority.

`plugin.yaml` and `__init__.py` remain an enabled no-op Hermes plugin shell, so
the language model gains no new tool or hook from this UI.
