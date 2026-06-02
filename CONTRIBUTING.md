# Contributing

## Setup

```sh
bun install --frozen-lockfile --ignore-scripts --minimum-release-age=604800
```

The repo currently has no third-party runtime dependencies. Keep that property unless a dependency removes meaningful complexity.

## Development

```sh
scripts/dev.sh
```

The script prints the API and dashboard URLs. In Conductor, the script uses the workspace's allocated `CONDUCTOR_PORT` range.

## Verification

Run the focused test suite:

```sh
bun test
```

Run a local API smoke test:

```sh
scripts/smoke-test.sh
```

## Pull Requests

- Keep changes scoped to one feature or integration boundary.
- Update `ARCHITECTURE.md` when contract boundaries or runtime topology change.
- Update `DEVELOPMENT.md` when setup, ports, scripts, or local services change.
- Add contract tests when changing shared data shapes.

## Dependency Policy

- Prefer locked installs and committed lockfiles.
- Keep `bunfig.toml` cooldown settings unless there is a documented reason to remove them.
- Do not add install hooks casually.
