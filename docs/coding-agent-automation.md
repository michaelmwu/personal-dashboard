# Oh My Pi Coding Agent Operations

Personal Dashboard is the durable controller for coding work. Oh My Pi (OMP)
is the task-scoped execution harness; Hermes owns conversational intake and
Telegram/Discord delivery.

## Runtime ownership

```text
Hermes/API request
  -> dashboard task + run request
  -> worker lease
  -> repo-specific worktree
  -> OMP RPC turn
  -> validation
  -> independent review
  -> checked host push / PR create
  -> PR, CI, and review polling
  -> bounded OMP repair or operator handoff
  -> Hermes result delivery
```

The dashboard database is canonical. OMP session logs provide evidence and
continuity, but a restart never reconstructs task, goal, approval, or delivery
state from transcript prose.

## Required worker configuration

```dotenv
CODING_AGENT_OMP_ENABLED=true
CODING_AGENT_WORK_ROOT=/srv/coding-agent/worktrees
PI_CODING_AGENT_DIR=/home/dashboard/.omp/agent
CODING_AGENT_REPO_MAP_JSON={"personal-dashboard":"/srv/personal-dashboard","moo-infra":"/srv/moo-infra"}

CODING_AGENT_AUTOMATION_ENABLED=true
CODING_AGENT_VALIDATION_ENABLED=true
CODING_AGENT_REVIEW_ENABLED=true
CODING_AGENT_PR_POLL_ENABLED=true
CODING_AGENT_PR_PUBLISH_ENABLED=true
CODING_AGENT_RECONCILE_ENABLED=true

CODING_AGENT_DELIVERY_ENABLED=true
CODING_AGENT_RESULT_TARGETS=telegram,discord:#agent-results
```

Leave `CODING_AGENT_OMP_MODEL` blank to use the model/provider selected in OMP's
owner-only config. Provider login is performed with OMP itself; existing Codex,
Claude, or Cursor CLI login state is not assumed. `CODING_AGENT_REPO_MAP_JSON`
is preferred when source checkouts do not share one parent.

The default reviewer policy starts a fresh OMP process/session in
`always-ask`, supplies the committed diff directly, and fails the gate if the
reviewer requests a mutation or does not return valid JSON. Set
`CODING_AGENT_REVIEW_PROVIDER` and `CODING_AGENT_REVIEW_MODEL` to route that
second pass to a different subscribed provider/model. A configured
OpenAI-compatible gateway, Codex read-only CLI, or Claude plan-mode CLI can
still be selected instead.

The OMP process receives a new per-task HOME and a child environment assembled
from an allowlist. Dashboard tokens, database URLs, GitHub tokens, SSH agent
state, Hermes credentials, and observability secrets are not forwarded. The
host worker retains GitHub credentials for deterministic push and PR actions.

## Manual and auto modes

`executionMode` is copied into each run request and cannot change during that
run.

- `manual` launches OMP with `--approval-mode always-ask`. Approval requests
  become typed `waiting-for-approval` state. Use `take-over-manually` to keep
  the worktree for a human fix, `manual-fix-complete` to rerun gates, or
  `resume-agent` to enqueue another OMP turn. Push and PR creation require an
  approved PR-maintenance item. Validation failures, review blockers, and new
  PR/CI feedback are recorded but do not enqueue a repair until the operator
  explicitly resumes OMP or finishes a manual fix.
- `auto` launches OMP with `--approval-mode yolo` for worktree edits and test
  commands. OMP's critical approval overrides still pause. Auto tasks require
  an approved mission and explicit validation commands. The host publishes only
  after validation and a clean independent review for the current run.

Neither mode auto-merges. High-risk schema, infrastructure, auth, money,
privacy, or destructive work retains the separate risk-approval gate.

To change the mode for the next action:

```json
POST /api/apps/coding-agent/control
{
  "taskId": "coding_task_...",
  "action": "set-execution-mode",
  "executionMode": "auto",
  "approvedBy": "michaelmwu",
  "approvalId": "mode-change-..."
}
```

## Scheduling a PR task

Schedules support an explicit `nextRunAt`, an `intervalMinutes`, or a standard
five-field cron expression evaluated in the stored IANA timezone. One due
occurrence creates one idempotent task/run pair.

```json
POST /api/apps/coding-agent/schedules
{
  "id": "weekly-doc-refresh",
  "title": "Weekly documentation refresh",
  "executionMode": "auto",
  "expression": "0 9 * * 1",
  "timezone": "America/Los_Angeles",
  "overlapPolicy": "skip",
  "template": {
    "repo": "personal-dashboard",
    "githubRepo": "michaelmwu/personal-dashboard",
    "title": "Refresh coding-agent docs",
    "prompt": "Update stale operator documentation and open a PR.",
    "mission": {
      "goal": "Keep coding-agent documentation current",
      "context": "Review implementation changes since the previous run.",
      "constraints": ["Do not change runtime behavior"],
      "allowedRepos": ["personal-dashboard"],
      "definitionOfDone": ["Docs match behavior", "Checks pass"],
      "validationCommands": ["bun run check"],
      "rollback": "Close and revert the documentation PR.",
      "status": "approved",
      "approvedBy": "michaelmwu",
      "approvalId": "weekly-doc-refresh-policy"
    }
  }
}
```

The worker calls `/api/apps/coding-agent/automation/tick`. Repeating a tick for
the same occurrence does not create a second task or PR.

## Repeated goals and cross-repo campaigns

A goal emits one measurable iteration at a time and pauses when its iteration
budget or no-progress limit is reached. Repository entries may be strings when
one mission safely applies to all, or objects with repo-specific prompt,
mission, source checkout, and validation.

A campaign stores dependency-ordered steps. Each step gets its own branch,
worktree, OMP process/session, validation, and PR. A dependent step becomes
ready only when all prerequisite steps reach a completed outcome. Partial
completion is retained explicitly; there is no synthetic cross-repo
transaction.

## Repair and publication

Auto tasks use one bounded repair budget across validation failures, review
blockers, PR feedback, CI failures, and base-branch conflicts. The worker:

1. fetches and attempts a deterministic base merge;
2. passes conflict paths or exact bounded failure evidence to OMP;
3. checkpoints completed work locally with Git hooks disabled;
4. reruns approved validation commands without a shell and records the exact
   clean commit SHA;
5. runs the configured independent reviewer against that same commit;
6. rechecks the clean worktree and reviewed SHA, then pushes the allowed task
   branch and creates or updates the PR with host-held
   GitHub credentials;
7. polls and deduplicates new CI/review feedback before queuing another repair.

Exhausted repair budgets move the task to `needs-clarification`. Host
publication failures produce an operator handoff instead of rerunning code.

## Delivery and recovery

Reportable outcomes create one `coding-delivery` fingerprint per task state,
run/PR, and target. Delivery retries do not rerun OMP or create another PR.

On restart, enable reconciliation. A running task without a run anchor, a quiet
leased run, or a stale task becomes a typed handoff with retained evidence.
Inspect these records before resuming:

```text
GET /api/apps/coding-agent/tasks?includeArchived=true
GET /api/apps/coding-agent/items?type=coding-run-request
GET /api/apps/coding-agent/items?type=coding-reconciliation
GET /api/apps/coding-agent/items?type=coding-delivery
```

Before accepting public issue/comment triggers, move execution into a stronger
per-run sandbox with default-deny network policy and brokered short-lived
credentials. The current systemd/worktree boundary is for a trusted personal
operator, not hostile multi-tenant input. Environment scrubbing is not an OS
security boundary: a process running as the worker's Unix user may still read
files that user can read.
