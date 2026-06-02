# Dependency Supply-Chain Policy

## Bun

Bun is the package manager for this repo.

`bunfig.toml` enforces a seven-day release cooldown:

```toml
[install]
minimumReleaseAge = 604800
```

Use frozen installs in setup and CI:

```sh
bun install --frozen-lockfile --ignore-scripts --minimum-release-age=604800
```

## Lockfiles

Commit `bun.lock` and update it intentionally with dependency changes.

## Renovate

`renovate.json` uses a seven-day minimum release age so dependency PRs do not fight Bun's cooldown policy.
