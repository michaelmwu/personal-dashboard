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

## Dependency Policy

- Bun uses `minimumReleaseAge = 604800` in `bunfig.toml`.
- CI and setup should use frozen installs.
- Renovate should preserve a seven-day minimum release age.

## GitHub Actions

Workflows should use least-privilege permissions, pinned action SHAs where practical, `persist-credentials: false`, and hardened runners for public or sensitive repositories.
