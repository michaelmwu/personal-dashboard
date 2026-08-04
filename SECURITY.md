# Security Policy

## Reporting Vulnerabilities

Do not open public issues for vulnerabilities, leaked secrets, or production data exposure.

Report security concerns through the private maintainer channel configured for this repository. Replace this paragraph with the real reporting address or process before opening the repository to outside contributors.

## Secret Handling

- Keep secrets in environment variables or encrypted files.
- Never commit real `.env` files, tokens, private keys, credentials, or production data.
- Use `.env.example` for documented configuration only.
- Use `.worktreeinclude` only for short allowlists of local config files that should copy into sibling worktrees.
- Plaid access tokens and sync cursors are stored only in the ignored local dashboard store during the personal-host bootstrap. Move them to encrypted storage before any multi-user or public deployment.
- Mutating dashboard API endpoints share the `PERSONAL_DASHBOARD_API_TOKEN` bearer-token gate when it is configured. Plaid webhooks still need Plaid JWT verification before being exposed on the public internet.
- Keep `HOTEL_RATE_FINDER_API_BASE_URL` on loopback or a private tailnet. The dashboard should talk only to the Hotel Rate Finder FastAPI agent API, never expose provider credentials or browser controls to the web client, and treat failed/stale scraper jobs as alertable states.
- Treat app manifests and `dashboard.config.yaml` as trusted server-side configuration. They can add Hermes capabilities and deterministic endpoints, so do not load manifests from untrusted public URLs or expose manifest editing to the web client without validation and review.

## Gmail Gateway

- The standalone `apps/email-gateway` process is the sole owner of Gmail OAuth
  client secrets, refresh tokens, and access tokens. Do not add those values to
  the dashboard API, web process, Hermes configuration, app manifests, or logs.
- Request exactly `https://www.googleapis.com/auth/gmail.readonly`. Never add
  `gmail.modify`, `mail.google.com`, IMAP app passwords, or any Gmail mutation
  scope to this application. A read-only scope is an enforcement boundary for
  the gateway's permanent no-delete policy.
- Keep the gateway process under a distinct OS user or container boundary when
  Hermes can run tools on the same host. Environment filtering alone does not
  protect files readable by the same Unix identity.
- Encrypt the local token store with a gateway-only encryption key and use an
  ignored file with owner-only permissions. A gateway startup without its
  configured encryption key must fail closed.
- The dashboard gateway-reader token may authorize only fixed search and
  receipt-bound message-read endpoints. The dashboard's event receiver uses a
  distinct `EMAIL_GATEWAY_EVENT_TOKEN`; neither token is a Google credential.
- Do not offer a generic upstream Gmail URL/method proxy. Keep fixed endpoint,
  result, message-size, receipt-TTL, request-rate, and daily-byte limits.
- Do not download attachments in the initial implementation. Sanitize bodies to
  bounded plain text, redact authentication codes and reset links, and mark all
  email-derived text as untrusted before an agent sees it.
- Automatic finance candidates require a configured issuer sender and domain,
  plus Gmail's first `Authentication-Results` header showing `mx.google.com`,
  `dmarc=pass`, and an aligned trusted domain. A visible From address alone is
  never enough to create a transaction candidate.
- Gateway event ingress accepts only the versioned, hash-ID transaction schema;
  it does not accept a raw email, a legacy Gmail intake payload, or arbitrary
  dashboard source event. Gmail search/read API routes fail closed unless the
  dashboard bearer authentication is configured.
- A deterministic Hermes Gmail search/read action returns the bounded result to
  its current caller but persists only receipt metadata and body length, never
  email text, subject, snippet, headers, or attachments in the action record.
- Receipt-bound Hermes analysis receives sanitized email text transiently and
  strips caller-supplied prompts before dispatch. Treat Hermes Bridge as a
  trusted data processor: it gets no Gmail credential, but its own logs and
  retention policy must be appropriate for the email content it analyzes.
- Log audit metadata without tokens, raw bodies, headers, or raw Gmail message
  IDs. Alert on expired watches, policy denials, token failures, and unusually
  high read volume.

## Dependency Policy

- Bun uses `minimumReleaseAge = 604800` in `bunfig.toml`.
- CI and setup should use frozen installs.
- Renovate should preserve a seven-day minimum release age.

## GitHub Actions

Workflows should use least-privilege permissions, pinned action SHAs where practical, `persist-credentials: false`, and hardened runners for public or sensitive repositories.
