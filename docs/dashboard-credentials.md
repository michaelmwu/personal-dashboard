# Dashboard credentials in 1Password

Deployment depends on [moo-infra PR #38](https://github.com/michaelmwu/moo-infra/pull/38),
including commit `7409a0e`, and the dashboard changes in
[PR #67](https://github.com/michaelmwu/personal-dashboard/pull/67). Neither PR by
itself completes deployment. These changes do not provision real vault items,
change service-account permissions, migrate live data, or deploy services.

## Runtime

The shared `Personal AI` vault and service account are read-only at runtime.
Services receiving this account can read all items in that vault, so it is a
shared trust boundary. The bootstrap token is held by moo-infra as a root-only
systemd credential, not in a checked-in file or the dashboard UI.

Set `personal_dashboard_onepassword_enable: true` in the existing ignored
moo-infra configuration after supplying the vault items and completing any
legacy bank-token migration. Configure these reference variables there:

| Infrastructure variable | Runtime environment variable |
| --- | --- |
| `personal_dashboard_plaid_client_id_ref` | `PLAID_CLIENT_ID` |
| `personal_dashboard_plaid_secret_ref` | `PLAID_SECRET` |
| `personal_dashboard_api_token_ref` | `PERSONAL_DASHBOARD_API_TOKEN` |

moo-infra writes references to protected env files and resolves the values with
`op run`. Only the API receives Plaid credentials and the read-only bootstrap
for dynamic lookups. The web and worker receive their required dashboard API
token, without Plaid credentials or bootstrap access. See moo-infra's
`docs/dashboard-onepassword.md` for the deployment steps, legacy env cleanup,
and same-user process-access limitation.

The API uses:

```dotenv
PLAID_TOKEN_STORAGE=onepassword
PERSONAL_DASHBOARD_OP_BINARY=/usr/local/bin/op
PERSONAL_DASHBOARD_OP_VAULT=Personal AI
```

Each bank connection stores only its Item ID, `accessTokenRef`, sync cursor,
and connection metadata in the dashboard store. The reference uses a stable
1Password item ID and the `access_token` field. Sync calls `op read` on demand,
using `OP_SERVICE_ACCOUNT_TOKEN` or the existing systemd
`CREDENTIALS_DIRECTORY/op-service-account-token` file. Secret values are not
cached in application storage, returned to browsers, or included in CLI error
messages. References and cursors are also omitted from dashboard responses.

A reference lookup failure never falls back to a legacy plaintext value. A
legacy connection reports `plaid_token_migration_required`; other connected
banks can still sync. Static credential rotation requires restarting the
services so `op run` resolves new values. Dynamic token values are reread on
subsequent syncs.

`PLAID_TOKEN_STORAGE=local` retains the old Link and plaintext-token behavior
only for local/sandbox development. Production (`ENVIRONMENT=production`/`prod` or
`PLAID_ENV=production`) requires `onepassword`, even if `local` is explicitly
requested. With no mode specified, production defaults to `onepassword` and
local development defaults to `local`.

## Owner provisioning identity

New connections and migrations use an owner-operated tool, not the deployed
API. Provision a separate service account with `read_items` and `write_items`
on the intended vault. Keep the shared runtime account read-only. Do not store
the writer bootstrap token in a vault the shared runtime account can read, and
do not install it in systemd credentials or app env files.

The tool requires `PERSONAL_DASHBOARD_OP_WRITER_TOKEN`. It rejects a token equal
to the shared runtime token when that token is available for comparison. This
check cannot establish the account's actual vault permissions; configure and
review those permissions in 1Password. The writer is used only for owner CLI
calls and is never inherited by the read-only `op` subprocess.

One way to launch the tool is an ignored, owner-only reference file such as
`.env.plaid-owner` (mode `0600`):

```dotenv
PLAID_CLIENT_ID=op://Personal AI/Plaid/client_id
PLAID_SECRET=op://Personal AI/Plaid/secret
PLAID_ENV=production
PLAID_CLIENT_NAME=MooHQ
PERSONAL_DASHBOARD_OP_BINARY=/usr/local/bin/op
PERSONAL_DASHBOARD_OP_VAULT=Personal AI
PERSONAL_DASHBOARD_OP_WRITER_TOKEN=op://OWNER_ONLY_VAULT/Plaid provisioner/credential
```

These are illustrative item/field names. Replace `OWNER_ONLY_VAULT` with a
vault accessible to the owner but not the shared service account. Run `op run`
from the owner's authenticated CLI session, without the shared
`OP_SERVICE_ACCOUNT_TOKEN` or a service's `CREDENTIALS_DIRECTORY` in that
session. No plaintext credentials are required in this reference file.

## Connect a new bank

1. Stop the dashboard API and integration worker. The JSON store currently
   serializes writes within a process, not between processes. The tool's
   required `--offline` flag is your acknowledgement that those writers are
   stopped; it does not stop or inspect services for you.
2. From this checkout, run as the dashboard store owner:

   ```sh
   op run --env-file=.env.plaid-owner -- bun scripts/plaid-credentials.mjs link --offline --store /absolute/path/to/dashboard-store.json
   ```

3. Open the one-time loopback URL printed by the tool, then connect through
   Plaid. The bootstrap and bank access tokens never enter that page. Its
   ephemeral session capability is in the URL fragment and is removed from
   browser history after load. If the tool runs remotely, forward its printed
   port with SSH and open the URL using `127.0.0.1` and the same port locally;
   do not expose the listener publicly.
4. The tool exchanges the public token in its own process, creates a concealed
   1Password field using JSON on stdin, verifies the saved token, and writes
   only its reference to the dashboard store. It exits after success or after
   15 minutes. Restart the API and worker, then refresh transactions.

If saving fails after the public-token exchange, use **Retry saving
connection** in the same tab. The access token remains only in the owner
process's memory until it succeeds or exits. If that process dies before the
vault write, the token cannot be recovered locally: reconnect through Plaid
and review any unused Item in Plaid. If the vault write succeeded but the local
write failed, retry finds the stable `Plaid connection <Item ID>` item and
verifies it before registering the reference. Conflicting or duplicate vault
items require owner resolution; the tool does not overwrite or delete them.

The dashboard's **Connect a bank** button explains this owner workflow in
1Password mode. The runtime Link/exchange endpoints return
`owner_provisioning_required` before contacting Plaid. This deliberately does
not add an unattended write-capable onboarding service.

## Migrate existing plaintext bank tokens

Stop the API and worker as above, then run:

```sh
op run --env-file=.env.plaid-owner -- bun scripts/plaid-credentials.mjs migrate --offline --store /absolute/path/to/dashboard-store.json
```

Migration processes one connection at a time. It removes a plaintext token
only after creating or locating its vault item and verifying the secret. It
retains the existing cursor, linked date, and metadata. On failure, the current
connection remains unchanged; previously completed connections are safe to
skip on a rerun. The canonical store remains mode `0600`.

Migration changes only the selected store file. Old backups, manually copied
stores, or archived deployment env files can still contain previous plaintext
credentials and need owner-managed cleanup. This tool does not erase backups,
decrypt the abandoned encryption-PR format, revoke Plaid Items, or rotate keys.

## Verify without credentials

```sh
bun test tests/plaid-credentials.test.mjs
bun run check
bun run test:e2e
```

Tests use fake vault and Plaid responses, including the separate owner identity,
CLI timeout/output limits, rejected cross-origin requests, failure recovery,
production endpoint restrictions, and public response redaction.

Reference: [1Password runtime injection](https://developer.1password.com/docs/cli/secrets-scripts),
[JSON item creation through stdin](https://www.1password.dev/cli/item-create), and
[service-account permissions](https://www.1password.dev/cli/reference/management-commands/service-account).
