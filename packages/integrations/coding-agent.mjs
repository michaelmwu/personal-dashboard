export const CODING_AGENT_APP_ID = "coding-agent";
export const CODING_AGENT_PICKUP_MARKERS = [
  "@coding-agent pickup",
  "@coding-agent pick up",
  "/coding-agent pickup",
  "/coding-agent pick up",
  "coding-agent: pickup",
  "coding-agent pickup"
];

export const CODING_TASK_STATUSES = [
  "queued",
  "running",
  "pr-open",
  "changes-requested",
  "waiting-for-approval",
  "merged",
  "abandoned",
  "failed",
  "archived"
];

const SIDE_EFFECT_ACTIONS = new Set([
  "push-update",
  "create-pr",
  "merge-pr",
  "cleanup-worktree",
  "reply-pr"
]);

const LIFECYCLE_TRANSITIONS = {
  queued: ["running", "pr-open", "changes-requested", "merged", "abandoned", "archived"],
  running: [
    "pr-open",
    "changes-requested",
    "waiting-for-approval",
    "failed",
    "abandoned",
    "archived"
  ],
  "pr-open": [
    "running",
    "changes-requested",
    "waiting-for-approval",
    "merged",
    "abandoned",
    "archived"
  ],
  "changes-requested": [
    "running",
    "pr-open",
    "waiting-for-approval",
    "failed",
    "abandoned",
    "archived"
  ],
  "waiting-for-approval": ["running", "pr-open", "changes-requested", "abandoned", "archived"],
  failed: ["running", "abandoned", "archived"],
  merged: ["archived"],
  abandoned: ["archived"],
  archived: []
};

export function codingAgentPolicyFromEnv(env = process.env) {
  return {
    allowedRepos: (env.CODING_AGENT_ALLOWED_REPOS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    branchPrefix: env.CODING_AGENT_BRANCH_PREFIX ?? "hermes",
    defaultBaseBranch: env.CODING_AGENT_DEFAULT_BASE_BRANCH ?? "origin/main"
  };
}

export function shortRepoName(repo) {
  const value = String(repo ?? "").trim();
  return value.includes("/") ? value.split("/").at(-1) : value;
}

export function slug(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

export function codingTaskId(payload) {
  if (payload.id || payload.taskId || payload.task_id) {
    return String(payload.id ?? payload.taskId ?? payload.task_id);
  }
  const prNumber = payload.prNumber ?? payload.pr_number;
  if (payload.pickupSource && payload.repo && prNumber) {
    return `coding_${slug(shortRepoName(payload.repo))}_pr_${prNumber}`;
  }
  const repo = slug(payload.repo ?? "repo");
  const title = slug(payload.title ?? payload.branch ?? payload.prNumber ?? "task");
  return `coding_${repo}_${title}_${Date.now()}`;
}

export function normalizeCodingTaskStatus(status, fallback = "queued") {
  const normalized = String(status ?? fallback);
  return CODING_TASK_STATUSES.includes(normalized) ? normalized : fallback;
}

export function assertTaskTransition(fromStatus, toStatus) {
  const from = normalizeCodingTaskStatus(fromStatus);
  const to = normalizeCodingTaskStatus(toStatus);
  if (from === to) {
    return true;
  }
  if (!LIFECYCLE_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`Invalid coding task transition: ${from} -> ${to}`);
  }
  return true;
}

function historyEntry(type, detail = {}, now = new Date().toISOString()) {
  return {
    id: `${type}_${Date.parse(now) || Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    ts: now,
    ...detail
  };
}

function queueItem(payload, now = new Date().toISOString()) {
  const kind = payload.kind ?? payload.action ?? "user-request";
  return {
    id:
      payload.id ??
      `queue_${Date.parse(now) || Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind,
    status: payload.status ?? "queued",
    title: payload.title ?? kind,
    detail: payload.detail,
    payload: payload.payload ?? payload,
    approvalRequired: payload.approvalRequired ?? SIDE_EFFECT_ACTIONS.has(kind),
    approvedBy: payload.approvedBy,
    approvalId: payload.approvalId,
    rejectionReason: payload.rejectionReason,
    createdAt: payload.createdAt ?? now,
    updatedAt: now
  };
}

function existingPayload(existing) {
  return existing?.payload ?? existing ?? {};
}

export function codingTaskItem(payload, existing, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const previous = existingPayload(existing);
  const id = codingTaskId({ ...previous, ...payload });
  const repo = payload.repo ?? previous.repo;
  const branch = payload.branch ?? previous.branch;
  const prNumber = payload.prNumber ?? payload.pr_number ?? previous.prNumber;
  const requestedStatus = normalizeCodingTaskStatus(
    payload.status ?? previous.status ?? existing?.status ?? "queued"
  );
  const currentStatus = normalizeCodingTaskStatus(previous.status ?? existing?.status ?? "queued");
  assertTaskTransition(currentStatus, requestedStatus);

  const title = payload.title ?? previous.title ?? `${repo ?? "Coding"} task`;
  const previewUrl = payload.previewUrl ?? payload.preview_url ?? previous.previewUrl;
  const detail = [repo, branch, prNumber ? `PR #${prNumber}` : undefined, previewUrl]
    .filter(Boolean)
    .join(" - ");
  const history =
    previous.id || payload.id
      ? [
          ...(previous.history ?? []),
          ...(currentStatus === requestedStatus
            ? []
            : [
                historyEntry("status-transition", { from: currentStatus, to: requestedStatus }, now)
              ])
        ]
      : [historyEntry("registered", { status: requestedStatus }, now)];

  return {
    id,
    app: CODING_AGENT_APP_ID,
    type: "coding-task",
    externalId: id,
    status: requestedStatus,
    title,
    detail,
    payload: {
      ...previous,
      id,
      repo,
      githubRepo: payload.githubRepo ?? payload.github_repo ?? previous.githubRepo,
      title,
      prompt: payload.prompt ?? previous.prompt,
      baseBranch: payload.baseBranch ?? payload.base_branch ?? previous.baseBranch,
      branch,
      worktreeDir: payload.worktreeDir ?? payload.worktree_dir ?? previous.worktreeDir,
      hermesSessionKey:
        payload.hermesSessionKey ?? payload.hermes_session_key ?? previous.hermesSessionKey,
      hermesRunId: payload.hermesRunId ?? payload.hermes_run_id ?? previous.hermesRunId,
      latestHermesRunId:
        payload.latestHermesRunId ?? payload.latest_hermes_run_id ?? previous.latestHermesRunId,
      hermesRunStatus:
        payload.hermesRunStatus ?? payload.hermes_run_status ?? previous.hermesRunStatus,
      prNumber,
      prUrl: payload.prUrl ?? payload.pr_url ?? previous.prUrl,
      headSha: payload.headSha ?? payload.head_sha ?? previous.headSha,
      previewUrl,
      checks: payload.checks ?? previous.checks,
      reviewState: payload.reviewState ?? payload.review_state ?? previous.reviewState,
      prState: payload.prState ?? payload.pr_state ?? previous.prState,
      pickupSource: payload.pickupSource ?? payload.pickup_source ?? previous.pickupSource,
      pickupMarker: payload.pickupMarker ?? payload.pickup_marker ?? previous.pickupMarker,
      pickupCommentId:
        payload.pickupCommentId ?? payload.pickup_comment_id ?? previous.pickupCommentId,
      pickupCommentUrl:
        payload.pickupCommentUrl ?? payload.pickup_comment_url ?? previous.pickupCommentUrl,
      pickedUpAt: payload.pickedUpAt ?? payload.picked_up_at ?? previous.pickedUpAt,
      lastCommentCursor:
        payload.lastCommentCursor ?? payload.last_comment_cursor ?? previous.lastCommentCursor,
      githubCursor: payload.githubCursor ?? payload.github_cursor ?? previous.githubCursor,
      latestPrEvents: payload.latestPrEvents ?? payload.latest_pr_events ?? previous.latestPrEvents,
      queue: payload.queue ?? previous.queue ?? [],
      history,
      status: requestedStatus,
      archivedAt: payload.archivedAt ?? payload.archived_at ?? previous.archivedAt,
      archiveReason: payload.archiveReason ?? payload.archive_reason ?? previous.archiveReason,
      createdAt: previous.createdAt ?? payload.createdAt ?? payload.created_at ?? now,
      updatedAt: now
    }
  };
}

export function inferPrStatus(payload, previousStatus = "pr-open") {
  if (payload.status) {
    return normalizeCodingTaskStatus(payload.status, previousStatus);
  }
  const reviewState = String(payload.reviewState ?? payload.review_state ?? "").toUpperCase();
  const prState = String(payload.prState ?? payload.pr_state ?? "").toUpperCase();
  const conclusion = String(
    payload.checks?.conclusion ?? payload.checkConclusion ?? ""
  ).toLowerCase();
  if (prState === "MERGED") {
    return "merged";
  }
  if (reviewState === "CHANGES_REQUESTED" || conclusion === "failure") {
    return "changes-requested";
  }
  return normalizeCodingTaskStatus(previousStatus, "pr-open");
}

export function codingAgentFixMode(events = []) {
  if (
    events.some(
      (event) =>
        event.kind === "check" &&
        ["failure", "timed_out", "cancelled", "action_required"].includes(
          String(event.conclusion ?? "").toLowerCase()
        )
    )
  ) {
    return "test-fix";
  }
  if (
    events.some(
      (event) =>
        event.kind === "review" &&
        ["CHANGES_REQUESTED", "COMMENTED"].includes(String(event.state ?? "").toUpperCase())
    ) ||
    events.some((event) => event.kind === "comment")
  ) {
    return "pr-feedback";
  }
  return "update";
}

export function codingAgentExecutorPayload(task, context = {}) {
  const events = context.events ?? context.actionable ?? [];
  const mode = context.mode ?? codingAgentFixMode(events);
  const githubRepo = context.githubRepo ?? context.repo ?? task.githubRepo ?? task.repo;
  const prNumber = context.prNumber ?? task.prNumber;
  const sessionId = task.hermesSessionKey ?? `coding-agent:${task.id}`;
  const worktreeInstruction = task.worktreeDir
    ? `Before inspecting or editing files, change into this task worktree: ${task.worktreeDir}`
    : "Resolve the task worktree from the coding task registry before inspecting or editing files.";

  return {
    taskId: task.id,
    repo: task.repo,
    githubRepo,
    prNumber,
    worktreeDir: task.worktreeDir,
    hermesSessionKey: task.hermesSessionKey,
    sessionId,
    mode,
    instructions: [
      "You are the coding-agent executor for a Personal Dashboard coding task.",
      "Use structured task fields as the source of truth; do not infer state from transcript prose.",
      worktreeInstruction,
      "Address only the supplied PR feedback, failed checks, or update request.",
      "Run the narrowest relevant tests or checks you can identify from the repository.",
      "Commit changes only on the registered task branch. Do not push, create PRs, merge, or clean up worktrees unless a deterministic approved maintenance item explicitly asks for that side effect.",
      "Report concise status with changed files, commands run, and any remaining blockers."
    ].join("\n"),
    prompt: [
      `Coding task: ${task.id}`,
      `Mode: ${mode}`,
      task.title ? `Title: ${task.title}` : undefined,
      githubRepo ? `GitHub repo: ${githubRepo}` : undefined,
      prNumber ? `PR: #${prNumber}` : undefined,
      task.branch ? `Branch: ${task.branch}` : undefined,
      task.worktreeDir ? `Worktree: ${task.worktreeDir}` : undefined,
      "",
      "Task prompt:",
      task.prompt ?? "(no original prompt recorded)",
      "",
      "Actionable events:",
      JSON.stringify(events, null, 2),
      context.checks ? "\nCheck summary:" : undefined,
      context.checks ? JSON.stringify(context.checks, null, 2) : undefined
    ]
      .filter(Boolean)
      .join("\n"),
    metadata: {
      runtimeOwner: "personal-dashboard.integration-worker",
      actionId: "update-coding-task",
      taskId: task.id,
      mode,
      repo: task.repo,
      githubRepo,
      prNumber,
      worktreeDir: task.worktreeDir,
      branch: task.branch,
      cursor: context.cursor
    }
  };
}

export function applyPrStatus(existing, payload, options = {}) {
  const previous = existingPayload(existing);
  return codingTaskItem(
    {
      ...payload,
      status: inferPrStatus(payload, previous.status ?? "pr-open")
    },
    existing,
    options
  );
}

export function enqueueCodingTaskItems(existing, payload, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const previous = existingPayload(existing);
  const items = Array.isArray(payload.items) ? payload.items : [payload];
  const queue = [...(previous.queue ?? []), ...items.map((item) => queueItem(item, now))];
  return codingTaskItem(
    { ...payload, queue, status: payload.status ?? previous.status },
    existing,
    {
      now
    }
  );
}

function repoAllowed(repo, policy) {
  return (
    !policy.allowedRepos.length ||
    policy.allowedRepos.includes(repo) ||
    policy.allowedRepos.includes(shortRepoName(repo))
  );
}

function branchAllowed(branch, policy) {
  if (!branch) {
    return false;
  }
  if (
    ["main", "master", "origin/main", "origin/master", policy.defaultBaseBranch].includes(branch)
  ) {
    return false;
  }
  return (
    branch.startsWith(`${policy.branchPrefix}/`) || branch.startsWith(`${policy.branchPrefix}-`)
  );
}

function approvalPresent(payload) {
  return Boolean(payload.approvedBy && payload.approvalId);
}

export function planPrMaintenance(
  existing,
  payload,
  policy = codingAgentPolicyFromEnv(),
  options = {}
) {
  const now = options.now ?? new Date().toISOString();
  const task = existingPayload(existing);
  const actions = Array.isArray(payload.actions) ? payload.actions : [payload.action ?? "poll-pr"];
  const results = [];
  let next = existing;

  for (const action of actions) {
    const item = queueItem(
      {
        kind: action,
        title: payload.title ?? `PR maintenance: ${action}`,
        payload: {
          taskId: task.id,
          repo: payload.repo ?? task.repo,
          prNumber: payload.prNumber ?? payload.pr_number ?? task.prNumber,
          branch: payload.branch ?? task.branch,
          action
        }
      },
      now
    );
    const repo = item.payload.repo;
    const branch = item.payload.branch;
    const sideEffect = SIDE_EFFECT_ACTIONS.has(action);
    let status = "approved";
    let rejectionReason;

    if (task.status === "archived") {
      status = "rejected";
      rejectionReason = "task_archived";
    } else if (!repoAllowed(repo, policy)) {
      status = "rejected";
      rejectionReason = "repo_not_allowed";
    } else if (sideEffect && !branchAllowed(branch, policy)) {
      status = "rejected";
      rejectionReason = "branch_not_allowed";
    } else if (sideEffect && !approvalPresent(payload)) {
      status = "blocked";
      rejectionReason = "approval_required";
    } else if (["merge-pr", "reply-pr", "poll-pr"].includes(action) && !item.payload.prNumber) {
      status = "rejected";
      rejectionReason = "missing_pr_number";
    }

    const plannedItem = {
      ...item,
      status,
      approvalRequired: sideEffect,
      approvedBy: payload.approvedBy,
      approvalId: payload.approvalId,
      rejectionReason,
      updatedAt: now
    };
    results.push(plannedItem);
    next = enqueueCodingTaskItems(
      next,
      {
        items: [plannedItem],
        status: status === "blocked" ? "waiting-for-approval" : task.status
      },
      { now }
    );
  }

  return {
    ok: results.every((item) => ["approved", "queued"].includes(item.status)),
    blocked: results.some((item) => item.status === "blocked"),
    rejected: results.some((item) => item.status === "rejected"),
    taskItem: next,
    maintenance: results
  };
}

export function commentRequestsCodingAgentPickup(body, markers = CODING_AGENT_PICKUP_MARKERS) {
  const normalizedBody = String(body ?? "").toLowerCase();
  return markers.some((marker) => normalizedBody.includes(String(marker).toLowerCase()));
}

export function pickupExistingPrTask(
  existing,
  payload,
  policy = codingAgentPolicyFromEnv(),
  options = {}
) {
  const now = options.now ?? new Date().toISOString();
  const githubRepo = payload.githubRepo ?? payload.github_repo;
  const repo = shortRepoName(payload.repo ?? githubRepo);
  const prNumber = payload.prNumber ?? payload.pr_number;
  if (!repo) {
    return { ok: false, statusCode: 400, reason: "missing_repo" };
  }
  if (!prNumber) {
    return { ok: false, statusCode: 400, reason: "missing_pr_number" };
  }
  if (!repoAllowed(githubRepo ?? repo, policy)) {
    return { ok: false, statusCode: 403, reason: "repo_not_allowed" };
  }
  if (existing?.payload?.status === "archived") {
    return { ok: false, statusCode: 409, reason: "coding_task_archived" };
  }

  const item = codingTaskItem(
    {
      id: payload.id,
      repo,
      githubRepo,
      title: payload.title ?? `Pick up PR #${prNumber}`,
      prompt:
        payload.prompt ??
        `Pick up existing PR #${prNumber} in ${githubRepo ?? repo}. Continue from the registered PR state and wait for deterministic approval before GitHub side effects.`,
      baseBranch: payload.baseBranch ?? payload.base_branch,
      branch: payload.branch,
      worktreeDir: payload.worktreeDir ?? payload.worktree_dir,
      hermesSessionKey: payload.hermesSessionKey ?? payload.hermes_session_key,
      prNumber,
      prUrl: payload.prUrl ?? payload.pr_url,
      headSha: payload.headSha ?? payload.head_sha,
      status: payload.status ?? existing?.payload?.status ?? "pr-open",
      pickupSource: payload.pickupSource ?? payload.pickup_source ?? "dashboard",
      pickupMarker: payload.pickupMarker ?? payload.pickup_marker,
      pickupCommentId: payload.pickupCommentId ?? payload.pickup_comment_id,
      pickupCommentUrl: payload.pickupCommentUrl ?? payload.pickup_comment_url,
      pickedUpAt: payload.pickedUpAt ?? payload.picked_up_at ?? now,
      queue: payload.queue ??
        existing?.payload?.queue ?? [
          queueItem(
            {
              kind: "pickup-existing-pr",
              status: "approved",
              title: `Pick up PR #${prNumber}`,
              approvalRequired: false,
              payload: {
                repo,
                githubRepo,
                prNumber,
                pickupSource: payload.pickupSource ?? payload.pickup_source ?? "dashboard",
                pickupCommentId: payload.pickupCommentId ?? payload.pickup_comment_id
              }
            },
            now
          )
        ]
    },
    existing,
    { now }
  );

  return { ok: true, statusCode: existing ? 200 : 202, taskItem: item, task: item.payload };
}

export function archiveCodingTask(existing, payload = {}, options = {}) {
  const previous = existingPayload(existing);
  const now = options.now ?? new Date().toISOString();
  const completedQueue = (previous.queue ?? []).map((item) =>
    ["completed", "rejected"].includes(item.status)
      ? item
      : { ...item, status: "archived", updatedAt: now }
  );
  return codingTaskItem(
    {
      queue: completedQueue,
      status: "archived",
      archivedAt: payload.archivedAt ?? payload.archived_at ?? now,
      archiveReason: payload.reason ?? payload.archiveReason ?? payload.archive_reason ?? "manual"
    },
    existing,
    { now }
  );
}

export function visibleCodingTasks(items, { includeArchived = false, status } = {}) {
  return items
    .filter((item) => includeArchived || item.payload?.status !== "archived")
    .filter((item) => !status || item.payload?.status === status)
    .sort((left, right) => {
      const leftUpdated = left.payload?.updatedAt ?? left.ts ?? "";
      const rightUpdated = right.payload?.updatedAt ?? right.ts ?? "";
      return rightUpdated.localeCompare(leftUpdated);
    });
}
