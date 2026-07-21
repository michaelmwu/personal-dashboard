# Personal Dashboard

Personal Dashboard is a monorepo for spend awareness, reward optimization, and agent-driven follow-up. It is designed to integrate with Hermes for fast transaction alerts and OpenClaw for recommendations, tasks, and operational workflows.

The dashboard is the context and control plane. Hermes can pull dashboard
context, see available capabilities, and submit action envelopes that later
dispatch into the source apps.

The first version is runnable with local fixtures. It models the dashboard you described: fast bank-email signals, slow source-of-truth transaction state, reward calculations, suspicious charge alerts, and OpenClaw actions in one place.

## What Is Included

- `apps/api`: local JSON API and future integration webhook receiver.
- `apps/web`: dashboard UI served from a separate local web port.
- `packages/contracts`: shared dashboard contract builders.
- `packages/integrations`: Hermes, OpenClaw, travel, finance, and intake adapter boundaries.
- `packages/fixtures`: realistic development data.
- `adapters/`: small native views for supported Hermes hosts; these do not
  replace the standalone web application.
- `scripts/`: Conductor-aware worktree ports, dev launch, archive, stop, and smoke-test scripts.
- `dashboard.config.yaml`: enabled app registry and panel ordering.

## Quick Start

```sh
bun install --frozen-lockfile --ignore-scripts --minimum-release-age=604800
scripts/dev.sh
```

Then open the dashboard URL printed by the dev script.

## Verify

```sh
bun test
bun run smoke
bun run check
```

## Documentation

- [Architecture](ARCHITECTURE.md)
- [Development](DEVELOPMENT.md)
- [Contributing](CONTRIBUTING.md)
- [Agent Instructions](AGENTS.md)
- [Supply Chain Policy](docs/supply-chain.md)
- [GitHub Workflows](docs/github-workflows.md)

## Integration Framework

The dashboard now has placeholder contracts for the next personal surfaces:

- Hotel rate watches from `~/dev/hotel_rate_finder`.
- Flight watches from a future `~/dev/flight-searcher` service that owns
  Playwright/cloakbrowser search execution.
- Asia deal candidates from `~/dev/asiatraveldeals`.
- Plaid account/transaction sync through the official Plaid Node SDK.
- Gmail intake for reservations, statements, and important email.

These are fixture-backed today. Real provider code should land in
`packages/integrations/` first, then flow through `/api/dashboard` without
provider-specific parsing in the web app.

## Host Dashboard Adapters

The standalone dashboard remains the complete application. `adapters/` contains
small, read-only native views for hosts that already own the user's session:

- `adapters/hermes-dashboard`: an official Hermes Dashboard plugin. Its browser
  code uses the Hermes SDK session path and its server-side plugin route reads
  only the dashboard's loopback summary endpoint.
- `adapters/hermes-webui`: an experimental Hermes WebUI extension. It renders a
  native panel through WebUI's fixed, consented loopback-sidecar proxy rather
  than embedding the standalone application.

Both adapters consume `GET /api/host-dashboard/summary`, a
`host-dashboard-summary.v1` projection containing health, metrics, alerts,
travel, and task status. It deliberately excludes the raw transactions,
accounts, Hermes actions, and provider payloads returned by `/api/dashboard`.
The endpoint is intended for a same-host loopback adapter; it is not a new
public API surface.

The official Hermes adapter inherits the Hermes Dashboard login. Hermes WebUI
is a separate application with separate authentication and requires explicit
sidecar-proxy approval in WebUI Settings. Neither adapter exposes
`PERSONAL_DASHBOARD_API_TOKEN`, Hermes cookies, or Bridge credentials to browser
JavaScript. The first release is read-only; host-originated mutations remain
out of scope until they have a dedicated scoped service identity and audit path.

Plugin-facing endpoints:

- `GET /api/apps`: enabled app manifests and configured panels from
  `dashboard.config.yaml`.
- `GET /api/apps/:appId/items?type=...`: generic app-specific items projected
  from core dashboard state plus opaque app events.
- `POST /api/apps/:appId/events`: generic event envelope for app-specific
  payloads that do not need a blessed core dashboard type.

Apps should declare `dashboard-manifest.json` files with panels, event types,
and Hermes capabilities. The dashboard keeps a small blessed set of core types
for cross-app joins, while app-specific details ride as opaque item payloads and
can deep-link back to the owning app.

Hermes-facing endpoints:

- `GET /api/hermes/context`: compact dashboard context for agent prompts.
- `GET /api/hermes/capabilities`: actions Hermes is allowed to trigger.
- `POST /api/hermes/actions`: normalized action envelope. Hermes-originated
  envelopes are kept in the dashboard queue; dashboard-originated envelopes can
  dispatch to Hermes Bridge when `HERMES_BRIDGE_URL` and
  `HERMES_BRIDGE_PASSWORD` are configured.

Set `PERSONAL_DASHBOARD_API_TOKEN` to require `Authorization: Bearer ...` on
the Hermes endpoints. The Bridge password stays server-side in the API process;
it must never be sent to the web client.

Coding Agent endpoints (see [the OMP operations guide](docs/coding-agent-automation.md)
for complete mode, scheduler, campaign, recovery, and delivery examples):

- `GET /api/apps/coding-agent/tasks`: list active coding tasks. Pass
  `includeArchived=true` to include archived records.
- `POST /api/apps/coding-agent/tasks`: register the durable task anchor
  `{id, repo, branch, worktreeDir, executionMode, ompSessionId, prNumber,
  previewUrl}`.
- `POST /api/apps/coding-agent/runs/claim`, `/runs/events`, and
  `/runs/complete`: lease queued OMP RPC runs and persist their lifecycle. A
  prompt acknowledgement is not completion; the worker waits for `agent_end`.
- `POST /api/apps/coding-agent/schedules`: create a durable one-shot, interval,
  or five-field cron schedule with idempotent occurrences.
- `POST /api/apps/coding-agent/goals`: create a bounded recurring goal with an
  iteration budget and no-progress cutoff.
- `POST /api/apps/coding-agent/campaigns`: create a dependency graph with one
  isolated task, worktree, and PR per repository.
- `POST /api/apps/coding-agent/automation/tick`: materialize due schedule
  occurrences, goal iterations, and campaign steps into tasks plus OMP runs.
- `POST /api/apps/coding-agent/deliveries`: persist idempotent final-result
  delivery attempts sent by the worker through `hermes send`.
- `POST /api/apps/coding-agent/intake-plan`: turn a request into a durable
  intake plan with clarification questions, proposed surfaces, and risk
  classification before execution.
- `POST /api/apps/coding-agent/queue-plan`: plan priority, duplicate
  candidates, and one-task-one-worktree allocation before execution.
- `POST /api/apps/coding-agent/pr-pickup`: register an existing PR as a
  managed coding task from the dashboard or an explicit pickup comment.
- `POST /api/apps/coding-agent/coordination`: attach Telegram, dashboard, or
  GitHub coordination anchors to a managed task.
- `POST /api/apps/coding-agent/control`: apply typed operator controls such as
  pause, continue, tests, preview, open-pr, archive, or handoff.
- `POST /api/apps/coding-agent/handoff-summary`: persist a concise handoff
  summary from blocked queue items, failed checks, PR events, and artifacts.
  Use `summaryId` only when explicitly choosing the stored summary item ID;
  plain `id` is treated as a request/source ID.
- `POST /api/apps/coding-agent/queue`: append typed work items to a task queue.
- `POST /api/apps/coding-agent/pr-status`: sync PR review/check/preview status
  onto a registered task.
- `POST /api/apps/coding-agent/reconcile`: mark orphaned or stale running tasks
  as requiring operator attention and persist a reconciliation audit record.
  Use `auditId` only when explicitly choosing the stored audit item ID.
- `POST /api/apps/coding-agent/pr-maintenance`: deterministically plan PR
  maintenance after enforcing repo allowlists, branch policy, PR-only rules, and
  side-effect approval requirements.
- `POST /api/apps/coding-agent/risk-review`: classify blast radius for a
  coding-agent action and require approval for high-risk surfaces such as
  schema, infra, auth, money, privacy, or destructive changes.
- `POST /api/apps/coding-agent/signals`: persist typed improvement signals from
  CI, PR reviews, Telegram corrections, guardrails, or Hermes runs.
- `POST /api/apps/coding-agent/findings`: persist or synthesize recurring
  improvement findings from typed signals.
- `POST /api/apps/coding-agent/regression-memory`: persist concise prior
  failure/root-cause memory that PR polling can inject into future executor
  payloads for matching repos and failed checks.
- `POST /api/apps/coding-agent/goal-mutations`: draft and audit dry-run GitHub
  issue, Hermes memory, Telegram, or coding-task mutations from validated
  findings. Non-dry-run requests require `{approvedBy, approvalId}` and still
  persist a preview instead of calling providers directly. Use `mutationId`
  only when explicitly choosing the stored mutation item ID; plain `id` is
  treated as a request/source ID.
- `POST /api/apps/coding-agent/archive`: archive a completed or abandoned task
  and its remaining queue items.

Coding execution is owned by Oh My Pi RPC; orchestration remains owned by the
dashboard. `start-coding-task` and `update-coding-task` enqueue durable
`coding-run-request` records instead of forwarding coding work through Hermes
Bridge. Hermes remains the conversational intake and Telegram/Discord delivery
surface. The worker launches OMP with the task worktree as cwd, a per-task home,
and an environment allowlist that excludes dashboard, database, GitHub,
messaging, and observability credentials.

Every task stores `executionMode: manual | auto`. Manual mode launches OMP with
`always-ask`, does not auto-dispatch validation/review/PR-feedback repairs, and
requires approved host-action items before push or PR creation.
Auto mode launches with `yolo` inside the task worktree, but GitHub credentials
remain host-only: after current-run validation and a clean independent review,
the worker performs checked `git push` and `gh pr create` actions only if the
worktree is still clean at the exact reviewed commit. Critical OMP
approval prompts still pause as typed approval requests. Neither mode
auto-merges.

Coding-agent state uses the JSON dashboard store by default for local
development. Set `CODING_AGENT_STATE_STORE=postgres` with `DATABASE_URL` to move
coding-agent items, task anchors, run status, and run events into Postgres; run
`bun run migrate:coding-agent` once after configuring the database to backfill
existing JSON records. Coding run evidence is written under
`CODING_AGENT_RUN_EVIDENCE_DIR` or `.data/runs` as NDJSON events plus final
artifacts such as diffs and status output. Archiving a task removes its evidence
packs unless the task has `keepEvidence=true`. Reconciliation also prunes
evidence packs older than `CODING_AGENT_RUN_EVIDENCE_RETENTION_DAYS`, which
defaults to 30 days; set it to `-1` to disable age-based pruning.

Set `CODING_AGENT_ALLOWED_REPOS` to a comma-separated repo allowlist when
enforcing PR-maintenance repo policy. `CODING_AGENT_BRANCH_PREFIX` defaults to
`hermes`. Manual side effects require `approvedBy` plus `approvalId`. Auto mode
may authorize push, PR creation, and PR replies only after current-run
validation and review; merge and destructive cleanup remain approval-gated.
High-risk side effects additionally require `riskAcceptedBy` plus
`riskApprovalId`.

Set `CODING_AGENT_OMP_ENABLED=true`, `CODING_AGENT_WORK_ROOT`, and either
`CODING_AGENT_REPO_MAP_JSON` or `CODING_AGENT_REPO_ROOT` to execute queued runs.
`PI_CODING_AGENT_DIR` points at OMP's owner-only provider auth/config store.
Leave `CODING_AGENT_OMP_MODEL` blank to use OMP's configured default model.
Enable the full controller with `CODING_AGENT_AUTOMATION_ENABLED`,
`CODING_AGENT_VALIDATION_ENABLED`, `CODING_AGENT_REVIEW_ENABLED`,
`CODING_AGENT_PR_PUBLISH_ENABLED`, and `CODING_AGENT_DELIVERY_ENABLED`.
`CODING_AGENT_RESULT_TARGETS` is a comma-separated allowlist such as
`telegram,discord:#agent-results`.

Set `CODING_AGENT_PR_POLL_ENABLED=true` on the integration worker to poll active
coding-task PRs with `gh api`. The poller reads `pr-open`,
`changes-requested`, and `waiting-for-approval` tasks, advances the task's
GitHub cursor through `/api/apps/coding-agent/pr-status`, and dispatches the
agentic `update-coding-task` capability only when new actionable reviews,
comments, or failed checks are found. Use `CODING_AGENT_GITHUB_OWNER` when task
records store repo names without an owner.

Set `CODING_AGENT_PR_PICKUP_ENABLED=true` on the integration worker to scan
allowlisted repos for explicit pickup comments such as `@coding-agent pick up`
or `/coding-agent pickup`. The pickup scanner reads recent issue comments and
PR metadata with `gh api`, skips already-managed PRs, and persists the PR
through `/api/apps/coding-agent/pr-pickup`; it does not write marker comments or
mutate GitHub during discovery. GitHub-comment pickup denies bot actors by
default, accepts `OWNER`, `MEMBER`, and `COLLABORATOR` author associations, and
can be narrowed with `CODING_AGENT_PICKUP_TRUSTED_ACTORS` or
`CODING_AGENT_TRUSTED_ACTORS`. Accepted and rejected pickup decisions are stored
as `coding-pr-pickup-attempt` audit items. Use `CODING_AGENT_PICKUP_REPOS` to
narrow the scan list beyond `CODING_AGENT_ALLOWED_REPOS`.

`POST /api/apps/coding-agent/issue-triage` records a deterministic
`coding-issue-triage` item for GitHub issue intake. Issue prose is treated as
untrusted: prompt-injection patterns, untrusted authors, repo policy failures,
and high-risk scope produce an approval-required triage result instead of a
task draft. The endpoint does not create GitHub issues, comments, or coding
tasks. Set `CODING_AGENT_ISSUE_TRIAGE_ENABLED=true` on the integration worker
to scan open GitHub issues with `gh api`; use `CODING_AGENT_ISSUE_TRIAGE_REPOS`
to narrow the scan list, otherwise it reuses pickup/allowed repos. The scanner
skips PRs and already-triaged issues before posting to the dashboard triage
endpoint.

Coding tasks reserve a 10-port local block for their thread. The task payload
stores `portRange` plus `conductorPort`, and executor payloads include
`CONDUCTOR_PORT=<base>` so repo worktree port scripts can use `<base>-<base+9>`
without colliding with other active coding-agent tasks. Defaults are
`CODING_AGENT_PORT_BASE=12000` and `CODING_AGENT_PORT_SLOTS=400`; explicit
`conductorPort` values are rounded down to the nearest `...0` block base.

Set `CODING_AGENT_RECONCILE_ENABLED=true` on the integration worker to run
dashboard-side reconciliation. It posts to
`/api/apps/coding-agent/reconcile`, does not contact providers, and records
`coding-reconciliation` audit items. Use `CODING_AGENT_STALE_RUNNING_MINUTES`
to override the default 90-minute stale running threshold, and
`CODING_AGENT_RUN_QUIET_MINUTES` to override the default 10-minute event quiet
window that marks active OMP runs as stalled. Reconciliation runs on
startup and every worker polling interval by default; set
`CODING_AGENT_RECONCILE_WATCHDOG_ENABLED=false` to keep it startup-only.

Plaid-facing endpoints:

- `POST /api/integrations/plaid/link-token`: create a Plaid Link token for the
  browser Link flow.
- `POST /api/integrations/plaid/exchange-public-token`: exchange Link's
  `public_token` for an access token and store it in the ignored local
  dashboard store.
- `POST /api/integrations/plaid/sync`: run deterministic `/transactions/sync`
  for linked Items and upsert accounts/transactions into the dashboard.
- `POST /api/integrations/plaid/webhook`: accept Plaid transaction webhooks and
  trigger sync on `SYNC_UPDATES_AVAILABLE`.

Set `PLAID_CLIENT_ID`, `PLAID_SECRET`, and `PLAID_ENV`. The access token store
is local ignored data for now; move it behind encrypted storage before using
this outside a personal trusted host.

Hotel Rate Finder endpoints:

- `POST /api/travel/reservations`: upsert a manual hotel reservation with
  confirmation number, paid rate/currency, room class, cancellation policy, and
  Hyatt/IHG property metadata.
- `POST /api/integrations/hotel-rate-finder/sync`: ensure each active
  refundable Hyatt/IHG hotel reservation has a saved search in
  `hotel_rate_finder`, run it through the service's agent API, poll the job,
  and snapshot the cheapest cancellable comparable rate into travel watches.

Set `HOTEL_RATE_FINDER_API_BASE_URL` to the local or tailnet FastAPI service.
The dashboard never imports provider internals or runs browser scrapes; failed
or stale hotel jobs become dashboard alerts so a broken scraper does not look
like "no price drop."
