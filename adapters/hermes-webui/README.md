# Personal Dashboard Hermes WebUI extension (experimental)

This optional, read-only extension adds a native DOM panel to
[nesquena/hermes-webui](https://github.com/nesquena/hermes-webui). It consumes
the stable `GET /api/host-dashboard/summary` contract through the WebUI's fixed
consented sidecar proxy; it never embeds the standalone dashboard, accesses an
API token, or makes mutations.

## Explicit opt-in

This bundle is disabled by default. An operator who already runs and trusts
Hermes WebUI must point its extension configuration at the checked-out adapter
directory and restart WebUI:

```sh
export HERMES_WEBUI_EXTENSION_DIR=/srv/personal-dashboard/adapters
export HERMES_WEBUI_EXTENSION_MANIFEST=hermes-webui/manifest.json
```

`HERMES_WEBUI_EXTENSION_DIR` must be an administrator-controlled, non-user-
writable directory. The extension runs with the logged-in WebUI session's
authority, so do not enable it on a shared host or from an untrusted checkout.

After WebUI starts, open **Settings → Extensions**, enable **Personal
Dashboard** if it is disabled, and explicitly approve its `personal-dashboard`
loopback sidecar proxy. The panel's fixed proxy request is:

```
/api/extensions/personal-dashboard/sidecar/api/host-dashboard/summary
```

Without that persisted consent, the panel intentionally shows an unavailable
state rather than attempting a direct browser request to port `8810`.

## Boundary and rollout

WebUI authenticates the browser request to its same-origin proxy. WebUI then
strips cookies, Authorization, and CSRF headers before forwarding the fixed
path to the loopback Personal Dashboard API. Keep the API bound to loopback;
do not expose port `8810` to make this extension work.

The extension uses an extension-owned button and a `main > .main-view` panel,
and restores the current Hermes view on close or Escape. All summary fields are
rendered with DOM `textContent`; no HTML from the dashboard response is
interpreted. Treat this as an experimental adapter until it has been exercised
against the particular Hermes WebUI version you operate.
