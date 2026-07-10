import { createHash } from "node:crypto";

export const CODING_AGENT_APP_ID = "coding-agent";
export const CODING_AGENT_PICKUP_MARKERS = [
  "@coding-agent pickup",
  "@coding-agent pick up",
  "/coding-agent pickup",
  "/coding-agent pick up",
  "coding-agent: pickup",
  "coding-agent pickup"
];

const TRUSTED_GITHUB_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const TERMINAL_CODING_TASK_STATUSES = new Set(["merged", "abandoned", "failed", "archived"]);
const CODING_AGENT_PORT_RANGE_SIZE = 10;
const DEFAULT_CODING_AGENT_PORT_BASE = 12000;
const DEFAULT_CODING_AGENT_PORT_SLOTS = 400;

export const CODING_TASK_STATUSES = [
  "queued",
  "needs-clarification",
  "paused",
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

export const CODING_AGENT_PRIORITIES = ["urgent", "high", "normal", "low"];

export const CODING_AGENT_CONTROL_ACTIONS = [
  "pause",
  "explain",
  "continue",
  "approve-mission",
  "tests",
  "preview",
  "open-pr",
  "archive",
  "handoff"
];

export const CODING_VALIDATION_STATUSES = ["passed", "failed", "skipped"];
export const CODING_REVIEW_STATUSES = ["clean", "findings", "blocked", "failed", "skipped"];

export const CODING_AGENT_GOAL_MUTATION_ACTIONS = [
  "create-github-issue",
  "update-github-issue",
  "write-hermes-memory",
  "start-coding-task",
  "post-telegram-message"
];

export const CODING_AGENT_RISK_CATEGORIES = [
  "docs",
  "tests",
  "code",
  "schema",
  "infra",
  "auth",
  "money",
  "privacy",
  "destructive"
];

const HIGH_RISK_CATEGORIES = new Set([
  "schema",
  "infra",
  "auth",
  "money",
  "privacy",
  "destructive"
]);

const LIFECYCLE_TRANSITIONS = {
  queued: [
    "needs-clarification",
    "paused",
    "running",
    "pr-open",
    "changes-requested",
    "waiting-for-approval",
    "merged",
    "abandoned",
    "archived"
  ],
  "needs-clarification": ["queued", "running", "waiting-for-approval", "abandoned", "archived"],
  paused: [
    "running",
    "pr-open",
    "changes-requested",
    "waiting-for-approval",
    "abandoned",
    "archived"
  ],
  running: [
    "needs-clarification",
    "paused",
    "pr-open",
    "changes-requested",
    "waiting-for-approval",
    "failed",
    "abandoned",
    "archived"
  ],
  "pr-open": [
    "running",
    "paused",
    "changes-requested",
    "waiting-for-approval",
    "merged",
    "abandoned",
    "archived"
  ],
  "changes-requested": [
    "running",
    "paused",
    "pr-open",
    "waiting-for-approval",
    "failed",
    "abandoned",
    "archived"
  ],
  "waiting-for-approval": [
    "paused",
    "running",
    "pr-open",
    "changes-requested",
    "abandoned",
    "archived"
  ],
  failed: ["running", "abandoned", "archived"],
  merged: ["archived"],
  abandoned: ["archived"],
  archived: []
};

export function codingAgentPolicyFromEnv(env = process.env) {
  const pickupTrustedActors = (
    env.CODING_AGENT_PICKUP_TRUSTED_ACTORS ??
    env.CODING_AGENT_TRUSTED_ACTORS ??
    ""
  )
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return {
    allowedRepos: (env.CODING_AGENT_ALLOWED_REPOS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    branchPrefix: env.CODING_AGENT_BRANCH_PREFIX ?? "hermes",
    defaultBaseBranch: env.CODING_AGENT_DEFAULT_BASE_BRANCH ?? "origin/main",
    portBase: Number.parseInt(
      env.CODING_AGENT_PORT_BASE ?? String(DEFAULT_CODING_AGENT_PORT_BASE),
      10
    ),
    portSlots: Number.parseInt(
      env.CODING_AGENT_PORT_SLOTS ?? String(DEFAULT_CODING_AGENT_PORT_SLOTS),
      10
    ),
    pickupTrustedActors,
    denyBotPickup: env.CODING_AGENT_PICKUP_ALLOW_BOTS !== "true"
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

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function alignPortBase(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.floor(parsed / CODING_AGENT_PORT_RANGE_SIZE) * CODING_AGENT_PORT_RANGE_SIZE;
}

function portRangeForBase(base) {
  return {
    base,
    start: base,
    end: base + CODING_AGENT_PORT_RANGE_SIZE - 1,
    size: CODING_AGENT_PORT_RANGE_SIZE,
    env: {
      CONDUCTOR_PORT: String(base)
    }
  };
}

function stablePortSlot(seed, slots) {
  const digest = createHash("sha256").update(String(seed)).digest("hex");
  return Number.parseInt(digest.slice(0, 8), 16) % slots;
}

function taskPayload(item) {
  return item?.payload ?? item ?? {};
}

function assignedPortBase(task) {
  return firstDefined(
    task.portRange?.base,
    task.port_range?.base,
    task.conductorPort,
    task.conductor_port
  );
}

function reservedPortBases(existingTasks = [], currentTaskId) {
  return new Set(
    existingTasks
      .map(taskPayload)
      .filter((task) => task.id !== currentTaskId)
      .filter((task) => !TERMINAL_CODING_TASK_STATUSES.has(task.status))
      .map(assignedPortBase)
      .map(alignPortBase)
      .filter((base) => base !== undefined)
  );
}

export function normalizeCodingTaskPortRange(payload = {}, existingTasks = [], options = {}) {
  const explicitBase = alignPortBase(
    firstDefined(
      payload.portRange?.base,
      payload.port_range?.base,
      payload.portRange?.start,
      payload.port_range?.start,
      payload.conductorPort,
      payload.conductor_port
    )
  );
  if (explicitBase !== undefined) {
    return portRangeForBase(explicitBase);
  }

  const currentTaskId = payload.id ?? payload.taskId ?? payload.task_id;
  const baseStart =
    alignPortBase(options.portBase ?? DEFAULT_CODING_AGENT_PORT_BASE) ??
    DEFAULT_CODING_AGENT_PORT_BASE;
  const parsedSlots = Number.parseInt(
    String(options.portSlots ?? DEFAULT_CODING_AGENT_PORT_SLOTS),
    10
  );
  const slots = Number.isFinite(parsedSlots)
    ? Math.max(1, parsedSlots)
    : DEFAULT_CODING_AGENT_PORT_SLOTS;
  const seed =
    firstDefined(
      payload.threadId,
      payload.thread_id,
      payload.coordination?.threadId,
      payload.coordination?.thread_id,
      currentTaskId,
      payload.repo,
      payload.githubRepo,
      payload.title,
      payload.prompt,
      payload.request
    ) ?? "coding-agent";
  const reserved = reservedPortBases(existingTasks, currentTaskId);
  const preferredSlot = stablePortSlot(seed, slots);

  for (let offset = 0; offset < slots; offset += 1) {
    const base = baseStart + ((preferredSlot + offset) % slots) * CODING_AGENT_PORT_RANGE_SIZE;
    if (base + CODING_AGENT_PORT_RANGE_SIZE - 1 > 65535) {
      continue;
    }
    if (!reserved.has(base)) {
      return portRangeForBase(base);
    }
  }

  throw new Error("No coding-agent port range available.");
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

function compactList(values = []) {
  return values.filter((value) => value !== undefined && value !== null && value !== "");
}

function numberOrZero(value) {
  const parsed = Number.parseInt(value ?? 0, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function normalizeCodingAgentPriority(priority = "normal") {
  const normalized = String(priority ?? "normal").toLowerCase();
  return CODING_AGENT_PRIORITIES.includes(normalized) ? normalized : "normal";
}

function normalizedDuplicateText(task) {
  return [
    task.title,
    task.request,
    task.prompt,
    task.description,
    task.branch,
    task.prNumber,
    task.pr_number
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, " ")
    .trim();
}

export function duplicateCodingTaskCandidates(payload = {}, tasks = []) {
  const candidateText = normalizedDuplicateText(payload);
  const repo = shortRepoName(payload.repo ?? payload.githubRepo ?? payload.github_repo);
  const prNumber = payload.prNumber ?? payload.pr_number;
  const requestedId = payload.taskId ?? payload.task_id ?? payload.id;
  return tasks
    .map(existingPayload)
    .filter((task) => task.status !== "archived" && (!requestedId || task.id !== requestedId))
    .map((task) => {
      const reasons = [];
      if (
        prNumber &&
        task.prNumber === prNumber &&
        repo &&
        shortRepoName(task.repo ?? task.githubRepo) === repo
      ) {
        reasons.push("same_pr");
      }
      if (
        payload.branch &&
        task.branch === payload.branch &&
        repo &&
        shortRepoName(task.repo ?? task.githubRepo) === repo
      ) {
        reasons.push("same_branch");
      }
      const taskText = normalizedDuplicateText(task);
      const sharedTerms = candidateText
        ? candidateText
            .split(" ")
            .filter(
              (term) =>
                term.length > 3 &&
                !["personal", "dashboard", "coding", "task", "hermes"].includes(term) &&
                taskText.includes(term)
            )
            .slice(0, 8)
        : [];
      if (sharedTerms.length >= 3) {
        reasons.push("similar_request");
      }
      return reasons.length
        ? {
            taskId: task.id,
            repo: task.repo,
            prNumber: task.prNumber,
            status: task.status,
            title: task.title,
            reasons
          }
        : undefined;
    })
    .filter(Boolean);
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
  const portRange = normalizeCodingTaskPortRange(
    {
      ...previous,
      ...payload,
      id
    },
    options.existingTasks ?? [],
    {
      portBase: options.portBase,
      portSlots: options.portSlots
    }
  );
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
      priority: normalizeCodingAgentPriority(payload.priority ?? previous.priority),
      duplicateOf: payload.duplicateOf ?? payload.duplicate_of ?? previous.duplicateOf,
      duplicateCandidates:
        payload.duplicateCandidates ?? payload.duplicate_candidates ?? previous.duplicateCandidates,
      intakePlan: payload.intakePlan ?? payload.intake_plan ?? previous.intakePlan,
      mission: payload.mission ?? payload.mission_spec ?? previous.mission,
      modelPolicy: normalizeCodingTaskModelPolicy(
        payload.modelPolicy ?? payload.model_policy ?? previous.modelPolicy ?? options.modelPolicy
      ),
      riskReview: payload.riskReview ?? payload.risk_review ?? previous.riskReview,
      coordination: payload.coordination ?? previous.coordination,
      latestControl: payload.latestControl ?? payload.latest_control ?? previous.latestControl,
      handoff: payload.handoff ?? previous.handoff,
      workspacePolicy:
        payload.workspacePolicy ?? payload.workspace_policy ?? previous.workspacePolicy,
      baseBranch: payload.baseBranch ?? payload.base_branch ?? previous.baseBranch,
      branch,
      worktreeDir: payload.worktreeDir ?? payload.worktree_dir ?? previous.worktreeDir,
      conductorPort: portRange.base,
      portRange,
      hermesSessionKey:
        payload.hermesSessionKey ?? payload.hermes_session_key ?? previous.hermesSessionKey,
      hermesRunId: payload.hermesRunId ?? payload.hermes_run_id ?? previous.hermesRunId,
      latestHermesRunId:
        payload.latestHermesRunId ?? payload.latest_hermes_run_id ?? previous.latestHermesRunId,
      hermesRunStatus:
        payload.hermesRunStatus ?? payload.hermes_run_status ?? previous.hermesRunStatus,
      lastEventAt: payload.lastEventAt ?? payload.last_event_at ?? previous.lastEventAt,
      hermesLastEventAt:
        payload.hermesLastEventAt ?? payload.hermes_last_event_at ?? previous.hermesLastEventAt,
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
      latestValidation:
        payload.latestValidation ?? payload.latest_validation ?? previous.latestValidation,
      validationAttempts:
        payload.validationAttempts ??
        payload.validation_attempts ??
        previous.validationAttempts ??
        0,
      reviewAttempts:
        payload.reviewAttempts ?? payload.review_attempts ?? previous.reviewAttempts ?? 0,
      repairAttempts:
        payload.repairAttempts ?? payload.repair_attempts ?? previous.repairAttempts ?? 0,
      latestReview: payload.latestReview ?? payload.latest_review ?? previous.latestReview,
      validationOverride:
        payload.validationOverride ?? payload.validation_override ?? previous.validationOverride,
      evidencePacks: payload.evidencePacks ?? payload.evidence_packs ?? previous.evidencePacks,
      keepEvidence: payload.keepEvidence ?? payload.keep_evidence ?? previous.keepEvidence,
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

export function codingTaskValidationPassed(task = {}) {
  const validation = task.latestValidation ?? task.latest_validation;
  return Boolean(validation && validation.status === "passed" && validation.passed !== false);
}

export function normalizeCodingTaskModelPolicy(policy = {}) {
  const source = policy && typeof policy === "object" ? policy : {};
  const normalizeSelection = (selection) => {
    if (!selection || typeof selection !== "object") {
      return undefined;
    }
    const harness = String(selection.harness ?? "").trim();
    const model = String(selection.model ?? "").trim();
    return harness && model ? { harness, model } : undefined;
  };
  const planner = normalizeSelection(source.planner);
  const executor = normalizeSelection(source.executor);
  const reviewer = normalizeSelection(source.reviewer);
  const fallbackChain = Array.isArray(source.fallbackChain ?? source.fallback_chain)
    ? (source.fallbackChain ?? source.fallback_chain).map(normalizeSelection).filter(Boolean)
    : [];
  const escalateOnRepairAttempt = Number.parseInt(
    source.escalateOnRepairAttempt ?? source.escalate_on_repair_attempt ?? 2,
    10
  );
  return {
    planner,
    executor,
    reviewer,
    fallbackChain,
    escalateOnRepairAttempt:
      Number.isFinite(escalateOnRepairAttempt) && escalateOnRepairAttempt > 0
        ? escalateOnRepairAttempt
        : 2
  };
}

export function codingTaskReviewPassed(task = {}) {
  const review = task.latestReview ?? task.latest_review;
  return Boolean(review && review.status === "clean" && !review.blockerCount);
}

export function normalizeCodingReviewResult(payload = {}, task = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  const normalizedFindings = findings.map((finding, index) => ({
    id: finding.id ?? `review_finding_${index + 1}`,
    severity: finding.severity === "blocker" ? "blocker" : "non-blocker",
    file: finding.file,
    line: Number.isFinite(finding.line) ? finding.line : undefined,
    summary: String(finding.summary ?? "").trim(),
    failureScenario: String(finding.failureScenario ?? finding.failure_scenario ?? "").trim()
  }));
  const blockerCount = normalizedFindings.filter(
    (finding) => finding.severity === "blocker"
  ).length;
  const status = CODING_REVIEW_STATUSES.includes(payload.status)
    ? payload.status
    : blockerCount
      ? "blocked"
      : normalizedFindings.length
        ? "findings"
        : "clean";
  return {
    id:
      payload.id ??
      `review_${slug(task.id ?? payload.taskId ?? "task")}_${Date.parse(now) || Date.now()}_${Number.parseInt(payload.attempt ?? task.reviewAttempts ?? 0, 10) + 1}`,
    taskId: payload.taskId ?? payload.task_id ?? task.id,
    runId: payload.runId ?? payload.run_id ?? task.latestHermesRunId ?? task.hermesRunId,
    status,
    blockerCount,
    attempt: Number.parseInt(payload.attempt ?? task.reviewAttempts ?? 0, 10) + 1,
    riskTier: payload.riskTier ?? payload.risk_tier ?? task.riskReview?.risk?.level ?? "medium",
    model: normalizeCodingTaskModelPolicy({ reviewer: payload.model ?? task.modelPolicy?.reviewer })
      .reviewer,
    findings: normalizedFindings,
    definitionOfDone: Array.isArray(payload.definitionOfDone ?? payload.definition_of_done)
      ? (payload.definitionOfDone ?? payload.definition_of_done)
      : [],
    summary: payload.summary,
    createdAt: payload.createdAt ?? payload.created_at ?? now,
    completedAt: payload.completedAt ?? payload.completed_at ?? now
  };
}

export function applyCodingTaskReview(existing, payload = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const previous = existingPayload(existing);
  const latestReview = normalizeCodingReviewResult(payload, previous, { now });
  const reviewAttempts = Math.max(numberOrZero(previous.reviewAttempts), latestReview.attempt);
  const repairAttempts = latestReview.blockerCount
    ? Math.max(numberOrZero(previous.repairAttempts) + 1, latestReview.attempt)
    : numberOrZero(previous.repairAttempts);
  const maxRepairAttempts = Number.parseInt(payload.maxRepairAttempts ?? 3, 10) || 3;
  const exhausted = latestReview.blockerCount > 0 && repairAttempts >= maxRepairAttempts;
  return enqueueCodingTaskItems(
    existing,
    {
      status: exhausted && previous.status === "running" ? "needs-clarification" : previous.status,
      latestReview,
      reviewAttempts,
      repairAttempts,
      handoff: exhausted
        ? {
            blocker: "review_blockers",
            attempted: latestReview.findings.map((finding) => finding.summary),
            artifacts: [`review:${latestReview.id}`],
            nextAction: "inspect reviewer blockers before continuing",
            createdAt: now
          }
        : previous.handoff,
      items: [
        {
          kind: "coding-review",
          status: latestReview.status,
          title: `Coding review ${latestReview.status}`,
          approvalRequired: false,
          payload: latestReview
        }
      ]
    },
    { now, modelPolicy: options.modelPolicy }
  );
}

export function normalizeCodingValidationResult(payload = {}, task = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const commands = Array.isArray(payload.commands) ? payload.commands : [];
  const status = CODING_VALIDATION_STATUSES.includes(payload.status)
    ? payload.status
    : commands.length && commands.every((command) => command.exitCode === 0)
      ? "passed"
      : "failed";
  const attempt =
    numberOrZero(payload.attempt ?? payload.validationAttempt ?? task.validationAttempts) || 1;
  const id =
    payload.id ??
    payload.validationId ??
    payload.validation_id ??
    `validation_${slug(task.id ?? payload.taskId ?? "task")}_${Date.parse(now) || Date.now()}_${attempt}`;
  return {
    id,
    taskId: payload.taskId ?? payload.task_id ?? task.id,
    runId: payload.runId ?? payload.run_id ?? task.latestHermesRunId ?? task.hermesRunId,
    worktreeDir: payload.worktreeDir ?? payload.worktree_dir ?? task.worktreeDir,
    status,
    passed: status === "passed",
    attempt,
    commands: commands.map((command, index) => ({
      index,
      command: String(command.command ?? ""),
      executable: command.executable,
      args: command.args ?? [],
      cwd: command.cwd,
      exitCode: Number.isFinite(command.exitCode) ? command.exitCode : undefined,
      signal: command.signal,
      durationMs: Number.isFinite(command.durationMs) ? command.durationMs : undefined,
      stdoutTail: command.stdoutTail ?? command.stdout_tail ?? "",
      stderrTail: command.stderrTail ?? command.stderr_tail ?? "",
      error: command.error
    })),
    summary: payload.summary,
    createdAt: payload.createdAt ?? payload.created_at ?? now,
    completedAt: payload.completedAt ?? payload.completed_at ?? now
  };
}

export function applyCodingTaskValidation(existing, payload = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const previous = existingPayload(existing);
  const latestValidation = normalizeCodingValidationResult(payload, previous, { now });
  const validationAttempts =
    latestValidation.status === "failed"
      ? Math.max(numberOrZero(previous.validationAttempts), latestValidation.attempt)
      : numberOrZero(previous.validationAttempts);
  const requestedMaxRepairAttempts = Number.parseInt(
    payload.maxRepairAttempts ?? payload.max_repair_attempts ?? 3,
    10
  );
  const maxRepairAttempts =
    Number.isFinite(requestedMaxRepairAttempts) && requestedMaxRepairAttempts >= 0
      ? requestedMaxRepairAttempts
      : 3;
  const repairAttempts =
    latestValidation.status === "failed"
      ? Math.max(numberOrZero(previous.repairAttempts) + 1, latestValidation.attempt)
      : numberOrZero(previous.repairAttempts);
  const exhausted = latestValidation.status === "failed" && repairAttempts >= maxRepairAttempts;
  const handoff = exhausted
    ? {
        blocker: "validation_failed",
        attempted: latestValidation.commands.map((command) => command.command),
        artifacts: [`validation:${latestValidation.id}`],
        nextAction: "inspect validation failure before continuing",
        createdAt: now
      }
    : previous.handoff;
  const status =
    latestValidation.status === "passed"
      ? previous.status
      : exhausted && previous.status === "running"
        ? "needs-clarification"
        : previous.status;

  return enqueueCodingTaskItems(
    existing,
    {
      status,
      latestValidation,
      validationAttempts,
      repairAttempts,
      handoff,
      items: [
        {
          kind: "coding-validation",
          status: latestValidation.status,
          title: `Coding validation ${latestValidation.status}`,
          approvalRequired: false,
          payload: latestValidation
        }
      ]
    },
    { now, modelPolicy: options.modelPolicy }
  );
}

function validationOverride(payload = {}, now = new Date().toISOString()) {
  if (payload.overrideValidation !== true && payload.override_validation !== true) {
    return undefined;
  }
  return {
    overridden: true,
    reason: payload.reason ?? payload.overrideReason ?? payload.override_reason,
    approvedBy: payload.approvedBy ?? payload.approved_by ?? payload.requestedBy,
    approvalId: payload.approvalId ?? payload.approval_id,
    createdAt: now
  };
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

export function normalizeCodingAgentRegressionMemory(payload = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const repo = payload.repo ?? payload.githubRepo ?? payload.github_repo;
  const checkName = payload.checkName ?? payload.check_name;
  const failureSignature =
    payload.failureSignature ?? payload.failure_signature ?? payload.signature ?? checkName;
  const rootCause = payload.rootCause ?? payload.root_cause ?? payload.summary;
  const title =
    payload.title ??
    compactList(["Regression memory", repo, checkName ?? failureSignature]).join(": ");
  const externalId =
    payload.id ??
    payload.externalId ??
    payload.external_id ??
    `regression_${slug(repo ?? "global")}_${slug(checkName ?? failureSignature ?? title)}_${Date.parse(now) || Date.now()}`;
  return {
    id: externalId,
    app: CODING_AGENT_APP_ID,
    type: "coding-regression-memory",
    externalId,
    status: payload.status ?? "active",
    title,
    detail: rootCause,
    payload: {
      id: externalId,
      status: payload.status ?? "active",
      repo,
      checkName,
      failureSignature,
      rootCause,
      avoid: payload.avoid ?? payload.avoidance ?? [],
      recommendedFix: payload.recommendedFix ?? payload.recommended_fix,
      evidence: payload.evidence ?? [],
      taskId: payload.taskId ?? payload.task_id,
      prNumber: payload.prNumber ?? payload.pr_number,
      tags: payload.tags ?? [],
      createdAt: payload.createdAt ?? payload.created_at ?? now,
      updatedAt: now
    }
  };
}

function failedCheckNames(context = {}) {
  const events = context.events ?? context.actionable ?? [];
  const checks = context.checks?.failed ?? [];
  return [
    ...events
      .filter((event) => event.kind === "check")
      .map((event) => event.name)
      .filter(Boolean),
    ...checks.map((check) => check.name).filter(Boolean)
  ];
}

export function relevantCodingAgentRegressionMemory(task, memories = [], context = {}) {
  const repo = shortRepoName(context.githubRepo ?? context.repo ?? task.githubRepo ?? task.repo);
  const checkNames = failedCheckNames(context).map((name) => String(name).toLowerCase());
  const eventText = JSON.stringify(context.events ?? context.actionable ?? []).toLowerCase();
  return memories
    .map(existingPayload)
    .filter((memory) => memory.status !== "archived")
    .filter((memory) => {
      const memoryRepo = shortRepoName(memory.repo ?? memory.githubRepo);
      if (repo && memoryRepo && repo !== memoryRepo) {
        return false;
      }
      const checkName = String(memory.checkName ?? "").toLowerCase();
      const signature = String(memory.failureSignature ?? "").toLowerCase();
      return (
        (checkName && checkNames.includes(checkName)) ||
        (signature && eventText.includes(signature)) ||
        (!checkNames.length && !signature)
      );
    })
    .slice(0, 5);
}

export function codingAgentExecutorPayload(task, context = {}) {
  const events = context.events ?? context.actionable ?? [];
  const mode = context.mode ?? codingAgentFixMode(events);
  const githubRepo = context.githubRepo ?? context.repo ?? task.githubRepo ?? task.repo;
  const prNumber = context.prNumber ?? task.prNumber;
  const regressionMemory =
    context.regressionMemory ?? context.regression_memory ?? task.regressionMemory ?? [];
  const sessionId = task.hermesSessionKey ?? `coding-agent:${task.id}`;
  const worktreeInstruction = task.worktreeDir
    ? `Before inspecting or editing files, change into this task worktree: ${task.worktreeDir}`
    : "Resolve the task worktree from the coding task registry before inspecting or editing files.";
  const mission = task.mission;
  const portRange = task.portRange ?? normalizeCodingTaskPortRange(task);
  const portInstruction = `Use this task's local port block when running dev servers: export CONDUCTOR_PORT=${portRange.base}. The repo worktree port script may use ports ${portRange.start}-${portRange.end}.`;

  return {
    taskId: task.id,
    repo: task.repo,
    githubRepo,
    prNumber,
    worktreeDir: task.worktreeDir,
    conductorPort: portRange.base,
    portRange,
    env: {
      CONDUCTOR_PORT: String(portRange.base)
    },
    hermesSessionKey: task.hermesSessionKey,
    sessionId,
    mode,
    instructions: [
      "You are the coding-agent executor for a Personal Dashboard coding task.",
      "Use structured task fields as the source of truth; do not infer state from transcript prose.",
      worktreeInstruction,
      portInstruction,
      "Address only the supplied PR feedback, failed checks, or update request.",
      "Use regression memory as evidence about prior failed fixes; do not blindly retry known-bad approaches.",
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
      `Port block: ${portRange.start}-${portRange.end} (CONDUCTOR_PORT=${portRange.base})`,
      "",
      mission ? "Mission:" : undefined,
      mission ? JSON.stringify(mission, null, 2) : undefined,
      mission ? "" : undefined,
      "Task prompt:",
      task.prompt ?? "(no original prompt recorded)",
      "",
      "Actionable events:",
      JSON.stringify(events, null, 2),
      regressionMemory.length ? "\nRegression memory:" : undefined,
      regressionMemory.length ? JSON.stringify(regressionMemory, null, 2) : undefined,
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
      conductorPort: portRange.base,
      portRange,
      branch: task.branch,
      cursor: context.cursor,
      regressionMemoryCount: regressionMemory.length
    }
  };
}

export function applyPrStatus(existing, payload, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const previous = existingPayload(existing);
  const incomingEvents = payload.latestPrEvents ?? payload.latest_pr_events;
  const requestedStatus = inferPrStatus(payload, previous.status ?? "pr-open");
  const override = validationOverride(payload, now);
  if (
    previous.status === "running" &&
    requestedStatus === "pr-open" &&
    (!codingTaskValidationPassed(previous) || !codingTaskReviewPassed(previous)) &&
    !override
  ) {
    return enqueueCodingTaskItems(
      existing,
      {
        ...payload,
        latestPrEvents:
          Array.isArray(incomingEvents) && incomingEvents.length > 0
            ? incomingEvents
            : previous.latestPrEvents,
        status: "waiting-for-approval",
        handoff: {
          blocker: !codingTaskValidationPassed(previous)
            ? "validation_required"
            : "review_required",
          attempted: ["sync-pr-status"],
          artifacts: previous.latestValidation
            ? [`validation:${previous.latestValidation.id}`]
            : [],
          nextAction: !codingTaskValidationPassed(previous)
            ? "run validate-coding-task or explicitly override validation"
            : "run review-coding-task or explicitly override validation",
          createdAt: now
        },
        items: [
          {
            kind: !codingTaskValidationPassed(previous)
              ? "coding-validation-required"
              : "coding-review-required",
            status: "blocked",
            title: "Validation required before PR-ready",
            approvalRequired: true,
            payload: {
              requestedStatus,
              latestValidation: previous.latestValidation,
              providerMutationAllowed: false
            }
          }
        ]
      },
      { now }
    );
  }
  return codingTaskItem(
    {
      ...payload,
      validationOverride: override ?? previous.validationOverride,
      latestPrEvents:
        Array.isArray(incomingEvents) && incomingEvents.length > 0
          ? incomingEvents
          : previous.latestPrEvents,
      status: requestedStatus
    },
    existing,
    { ...options, now }
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
    policy.allowedRepos.some((candidate) => repoMatches(candidate, repo))
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

function stringList(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.map((item) => String(item).trim()).filter(Boolean);
}

function repoMatches(candidate, repo) {
  if (!candidate || !repo) {
    return false;
  }
  const candidateHasOwner = String(candidate).includes("/");
  const repoHasOwner = String(repo).includes("/");
  if (candidateHasOwner && repoHasOwner) {
    return candidate === repo;
  }
  if (repoHasOwner) {
    return candidate === shortRepoName(repo);
  }
  return candidate === repo || shortRepoName(candidate) === repo;
}

export function normalizeCodingTaskMission(payload = {}, policy = codingAgentPolicyFromEnv()) {
  const source = payload.mission ?? payload;
  const repo = payload.repo ?? payload.githubRepo ?? payload.github_repo ?? source.repo;
  const allowedRepos = stringList(
    source.allowedRepos ?? source.allowed_repos ?? payload.allowedRepos ?? repo
  );
  const definitionOfDone = stringList(
    source.definitionOfDone ??
      source.definition_of_done ??
      payload.definitionOfDone ??
      payload.definition_of_done ??
      payload.acceptanceCriteria ??
      payload.acceptance_criteria
  );
  const validationCommands = stringList(
    source.validationCommands ??
      source.validation_commands ??
      payload.validationCommands ??
      payload.validation_commands
  );
  const approvedBy = source.approvedBy ?? source.approved_by ?? payload.approvedBy;
  const approvalId = source.approvalId ?? source.approval_id ?? payload.approvalId;
  const approved = Boolean(source.approved ?? source.operatorApproved ?? source.operator_approved);
  const mission = {
    goal: String(source.goal ?? payload.goal ?? payload.title ?? payload.request ?? "").trim(),
    context: String(
      source.context ?? payload.context ?? payload.request ?? payload.prompt ?? ""
    ).trim(),
    constraints: stringList(source.constraints ?? payload.constraints),
    allowedRepos,
    definitionOfDone: definitionOfDone.length
      ? definitionOfDone
      : ["Requested change is implemented.", "Relevant checks pass."],
    validationCommands,
    rollback: String(
      source.rollback ??
        payload.rollback ??
        "Revert the task branch or PR and redeploy the previous known-good version."
    ).trim(),
    status: approved || approvalPresent({ approvedBy, approvalId }) ? "approved" : "draft",
    approvedBy,
    approvalId,
    approvedAt: source.approvedAt ?? source.approved_at
  };
  const disallowedRepos = mission.allowedRepos.filter((repo) => !repoAllowed(repo, policy));
  const errors = [];
  if (!mission.goal) {
    errors.push("missing_mission_goal");
  }
  if (!mission.allowedRepos.length) {
    errors.push("missing_mission_allowed_repos");
  }
  if (
    (repo && !mission.allowedRepos.some((candidate) => repoMatches(candidate, repo))) ||
    disallowedRepos.length
  ) {
    errors.push("mission_allowed_repo_not_allowed");
  }
  if (!mission.rollback) {
    errors.push("missing_mission_rollback");
  }
  return { mission, errors, disallowedRepos };
}

export function codingTaskMissionApproved(mission) {
  return Boolean(
    mission &&
      mission.status === "approved" &&
      mission.approvedBy &&
      mission.approvalId &&
      mission.goal &&
      mission.allowedRepos?.length
  );
}

function riskApprovalPresent(payload) {
  return Boolean(
    (payload.riskAcceptedBy && payload.riskApprovalId) ||
      (payload.risk_accepted_by && payload.risk_approval_id)
  );
}

function textFromPayload(payload) {
  return [
    payload.prompt,
    payload.request,
    payload.title,
    payload.body,
    payload.summary,
    ...(Array.isArray(payload.actions) ? payload.actions : []),
    ...(Array.isArray(payload.files) ? payload.files : [])
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function categoriesFromFiles(files = []) {
  const normalized = files.map((file) => String(file).toLowerCase());
  const categories = new Set();
  if (
    normalized.length &&
    normalized.every((file) => file.endsWith(".md") || file.includes("docs/"))
  ) {
    categories.add("docs");
  }
  if (
    normalized.some(
      (file) =>
        file.includes("test") ||
        file.includes("spec") ||
        file.includes("__tests__") ||
        file.endsWith(".snap")
    )
  ) {
    categories.add("tests");
  }
  if (
    normalized.some(
      (file) =>
        file.includes("migration") ||
        file.includes("schema") ||
        file.endsWith(".sql") ||
        file.includes("prisma")
    )
  ) {
    categories.add("schema");
  }
  if (
    normalized.some(
      (file) =>
        file.includes("ansible/") ||
        file.includes(".github/workflows/") ||
        file.includes("docker") ||
        file.includes("terraform") ||
        file.includes("systemd") ||
        file.endsWith(".service")
    )
  ) {
    categories.add("infra");
  }
  if (
    normalized.some(
      (file) =>
        file.endsWith(".js") ||
        file.endsWith(".mjs") ||
        file.endsWith(".ts") ||
        file.endsWith(".tsx")
    )
  ) {
    categories.add("code");
  }
  return categories;
}

export function classifyCodingAgentRisk(payload = {}) {
  const categories = new Set(payload.categories ?? payload.riskCategories ?? []);
  for (const category of categoriesFromFiles(payload.files ?? payload.changedFiles ?? [])) {
    categories.add(category);
  }
  const text = textFromPayload(payload);
  if (/\b(auth|oauth|permission|role|session|login|token)\b/.test(text)) {
    categories.add("auth");
  }
  if (/\b(payment|billing|invoice|stripe|card|money|price|refund)\b/.test(text)) {
    categories.add("money");
  }
  if (/\b(privacy|pii|email|address|secret|credential|password|ssn)\b/.test(text)) {
    categories.add("privacy");
  }
  if (/\b(delete|drop|truncate|destroy|wipe|reset --hard|force-push|rm -rf)\b/.test(text)) {
    categories.add("destructive");
  }
  if (!categories.size) {
    categories.add("code");
  }
  const riskCategories = [...categories].filter((category) =>
    CODING_AGENT_RISK_CATEGORIES.includes(category)
  );
  const highRisk = riskCategories.some((category) => HIGH_RISK_CATEGORIES.has(category));
  return {
    categories: riskCategories,
    highRisk,
    level: highRisk ? "high" : riskCategories.includes("code") ? "medium" : "low",
    reasons: riskCategories.map((category) => `risk:${category}`)
  };
}

export function codingAgentIntakePlan(payload = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const policy = options.policy ?? codingAgentPolicyFromEnv();
  const request = payload.request ?? payload.prompt ?? "";
  const repo = payload.repo;
  const title = payload.title ?? (request ? request.split("\n")[0].slice(0, 80) : "Coding task");
  const risk = classifyCodingAgentRisk(payload);
  const missionResult = normalizeCodingTaskMission({ ...payload, title, request, repo }, policy);
  const clarifyingQuestions = [];
  if (!repo) {
    clarifyingQuestions.push("Which repository should this task run in?");
  }
  if (!request || request.trim().length < 12) {
    clarifyingQuestions.push("What concrete behavior or outcome should change?");
  }
  if (risk.highRisk && !approvalPresent(payload) && !riskApprovalPresent(payload)) {
    clarifyingQuestions.push(
      "This touches a high-risk area. What explicit approval should gate execution?"
    );
  }
  if (missionResult.errors.includes("mission_allowed_repo_not_allowed")) {
    clarifyingQuestions.push(
      "Mission allowedRepos must be a subset of CODING_AGENT_ALLOWED_REPOS."
    );
  }
  if (missionResult.errors.includes("missing_mission_goal")) {
    clarifyingQuestions.push("Mission goal is required before execution.");
  }
  const status = clarifyingQuestions.length
    ? risk.highRisk
      ? "waiting-for-approval"
      : "needs-clarification"
    : "queued";

  return {
    id: payload.planId ?? payload.plan_id ?? `plan_${Date.parse(now) || Date.now()}_${slug(title)}`,
    title,
    request,
    repo,
    status,
    risk,
    mission: missionResult.mission,
    missionErrors: missionResult.errors,
    clarifyingQuestions,
    proposedTests: payload.proposedTests ?? payload.proposed_tests ?? [],
    affectedSurfaces: payload.affectedSurfaces ?? payload.affected_surfaces ?? risk.categories,
    createdAt: now,
    updatedAt: now
  };
}

export function planCodingTaskIntake(payload = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const intakePlan = codingAgentIntakePlan(payload, { now, policy: options.policy });
  const item = codingTaskItem(
    {
      id: payload.taskId ?? payload.task_id ?? payload.id,
      repo: intakePlan.repo ?? payload.repo,
      title: intakePlan.title,
      prompt: intakePlan.request,
      mission: intakePlan.mission,
      branch: payload.branch,
      baseBranch: payload.baseBranch ?? payload.base_branch,
      status: intakePlan.status,
      intakePlan,
      riskReview: intakePlan.risk,
      queue: [
        queueItem(
          {
            kind: "intake-plan",
            status: intakePlan.clarifyingQuestions.length ? "blocked" : "approved",
            title: "Coding task intake plan",
            approvalRequired: intakePlan.risk.highRisk,
            rejectionReason: intakePlan.clarifyingQuestions.length
              ? "clarification_required"
              : undefined,
            payload: intakePlan
          },
          now
        )
      ]
    },
    undefined,
    { now, modelPolicy: options.modelPolicy }
  );
  return {
    ok: true,
    statusCode: intakePlan.status === "queued" ? 202 : 409,
    taskItem: item,
    task: item.payload,
    plan: intakePlan,
    blocked: intakePlan.status !== "queued"
  };
}

export function planCodingTaskQueue(payload = {}, existingTasks = [], options = {}) {
  const now = options.now ?? new Date().toISOString();
  const intakePlan = codingAgentIntakePlan(payload, { now, policy: options.policy });
  const duplicateCandidates = duplicateCodingTaskCandidates(payload, existingTasks);
  const priority = normalizeCodingAgentPriority(payload.priority);
  const blocked = intakePlan.status !== "queued" || duplicateCandidates.length > 0;
  const workspacePolicy = {
    mode: "one-task-one-worktree",
    workRoot: payload.workRoot ?? payload.work_root,
    branchPrefix: payload.branchPrefix ?? payload.branch_prefix ?? "hermes",
    portRangeSize: CODING_AGENT_PORT_RANGE_SIZE,
    portBase: options.policy?.portBase ?? DEFAULT_CODING_AGENT_PORT_BASE,
    retention: payload.retention ?? "archive-before-cleanup"
  };
  const portRange = normalizeCodingTaskPortRange(payload, existingTasks, {
    portBase: options.policy?.portBase,
    portSlots: options.policy?.portSlots
  });
  const item = codingTaskItem(
    {
      id: payload.taskId ?? payload.task_id ?? payload.id,
      repo: payload.repo,
      githubRepo: payload.githubRepo ?? payload.github_repo,
      title: intakePlan.title,
      prompt: intakePlan.request,
      mission: intakePlan.mission,
      branch: payload.branch,
      baseBranch: payload.baseBranch ?? payload.base_branch,
      portRange,
      priority,
      status: blocked ? "needs-clarification" : "queued",
      duplicateCandidates,
      duplicateOf: duplicateCandidates[0]?.taskId,
      intakePlan: {
        ...intakePlan,
        duplicateCandidates,
        status: blocked ? "needs-clarification" : intakePlan.status
      },
      riskReview: intakePlan.risk,
      workspacePolicy,
      queue: [
        queueItem(
          {
            kind: "queue-plan",
            status: blocked ? "blocked" : "approved",
            title: "Coding task queue plan",
            approvalRequired: intakePlan.risk.highRisk,
            rejectionReason: duplicateCandidates.length
              ? "duplicate_candidate"
              : blocked
                ? "clarification_required"
                : undefined,
            payload: {
              priority,
              duplicateCandidates,
              workspacePolicy,
              intakePlan
            }
          },
          now
        )
      ]
    },
    undefined,
    {
      now,
      modelPolicy: options.modelPolicy,
      existingTasks,
      portBase: options.policy?.portBase,
      portSlots: options.policy?.portSlots
    }
  );
  return {
    ok: true,
    statusCode: blocked ? 409 : 202,
    blocked,
    duplicateCandidates,
    priority,
    workspacePolicy,
    plan: item.payload.intakePlan,
    taskItem: item,
    task: item.payload
  };
}

export function reviewCodingAgentRisk(payload = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const risk = classifyCodingAgentRisk(payload);
  const action = payload.action ?? payload.kind ?? payload.capabilityId ?? "coding-agent-action";
  const requiresApproval = risk.highRisk || SIDE_EFFECT_ACTIONS.has(action);
  const approved = risk.highRisk
    ? riskApprovalPresent(payload)
    : requiresApproval
      ? approvalPresent(payload)
      : true;
  return {
    id:
      payload.id ??
      `risk_${Date.parse(now) || Date.now()}_${slug(payload.taskId ?? payload.repo ?? action)}`,
    app: CODING_AGENT_APP_ID,
    type: "coding-risk-review",
    externalId: payload.id,
    status: approved ? "approved" : "blocked",
    title: payload.title ?? `Risk review: ${action}`,
    detail: risk.categories.join(", "),
    payload: {
      taskId: payload.taskId ?? payload.task_id,
      repo: payload.repo,
      action,
      risk,
      approved,
      approvedBy: payload.approvedBy ?? payload.approved_by,
      approvalId: payload.approvalId ?? payload.approval_id,
      riskAcceptedBy: payload.riskAcceptedBy ?? payload.risk_accepted_by,
      riskApprovalId: payload.riskApprovalId ?? payload.risk_approval_id,
      createdAt: now,
      updatedAt: now
    }
  };
}

export function normalizeCodingAgentSignal(payload = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const source = payload.source ?? "manual";
  const kind = payload.kind ?? payload.type ?? "observation";
  const severity = ["low", "medium", "high"].includes(payload.severity)
    ? payload.severity
    : "medium";
  const taskId = payload.taskId ?? payload.task_id;
  const repo = payload.repo ?? payload.githubRepo ?? payload.github_repo;
  const prNumber = payload.prNumber ?? payload.pr_number;
  const title = payload.title ?? `Coding-agent signal: ${kind}`;
  const externalId =
    payload.id ??
    payload.externalId ??
    payload.external_id ??
    `signal_${slug(source)}_${slug(kind)}_${slug(taskId ?? repo ?? "global")}_${Date.parse(now) || Date.now()}`;
  return {
    id: externalId,
    app: CODING_AGENT_APP_ID,
    type: "coding-improvement-signal",
    externalId,
    status: payload.status ?? "active",
    title,
    detail: payload.summary ?? payload.detail,
    payload: {
      id: externalId,
      source,
      kind,
      severity,
      taskId,
      repo,
      prNumber,
      summary: payload.summary ?? payload.detail ?? title,
      evidence: payload.evidence ?? [],
      tags: payload.tags ?? [],
      createdAt: payload.createdAt ?? payload.created_at ?? now,
      updatedAt: now
    }
  };
}

export function updateCodingTaskCoordination(existing, payload = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const previous = existingPayload(existing);
  const anchor = {
    surface: payload.surface ?? payload.channel ?? previous.coordination?.surface ?? "dashboard",
    threadId: payload.threadId ?? payload.thread_id ?? previous.coordination?.threadId,
    chatId: payload.chatId ?? payload.chat_id ?? previous.coordination?.chatId,
    messageId: payload.messageId ?? payload.message_id ?? previous.coordination?.messageId,
    url: payload.url ?? previous.coordination?.url,
    createdBy: payload.createdBy ?? payload.created_by ?? previous.coordination?.createdBy,
    updatedAt: now
  };
  return codingTaskItem(
    {
      coordination: anchor,
      status: payload.status ?? previous.status
    },
    existing,
    { now, modelPolicy: options.modelPolicy }
  );
}

export function applyCodingTaskControl(existing, payload = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const previous = existingPayload(existing);
  const policy = options.policy ?? codingAgentPolicyFromEnv();
  const action = payload.action ?? payload.kind;
  if (!CODING_AGENT_CONTROL_ACTIONS.includes(action)) {
    return { ok: false, statusCode: 400, reason: "unsupported_control_action" };
  }
  if (previous.status === "archived" && action !== "archive") {
    return { ok: false, statusCode: 409, reason: "task_archived" };
  }
  const requestedApproval = {
    approvedBy:
      payload.approvedBy ?? payload.approved_by ?? payload.requestedBy ?? payload.requested_by,
    approvalId: payload.approvalId ?? payload.approval_id
  };
  const missionDraft =
    action === "approve-mission"
      ? normalizeCodingTaskMission(
          {
            ...previous,
            ...payload,
            mission: payload.mission ?? previous.mission
          },
          policy
        )
      : { mission: previous.mission, errors: [] };
  if (action === "approve-mission" && !missionDraft.mission) {
    return { ok: false, statusCode: 409, reason: "missing_mission" };
  }
  if (action === "approve-mission" && missionDraft.errors.length) {
    return {
      ok: false,
      statusCode: 409,
      reason: missionDraft.errors[0],
      errors: missionDraft.errors
    };
  }
  if (action === "approve-mission" && !approvalPresent(requestedApproval)) {
    return { ok: false, statusCode: 409, reason: "mission_approval_required" };
  }
  if (action === "continue" && !codingTaskMissionApproved(previous.mission)) {
    return { ok: false, statusCode: 409, reason: "mission_approval_required" };
  }
  const control = {
    action,
    requestedBy: payload.requestedBy ?? payload.requested_by,
    reason: payload.reason,
    createdAt: now
  };
  const mission =
    action === "approve-mission"
      ? {
          ...missionDraft.mission,
          status: "approved",
          approvedBy: requestedApproval.approvedBy,
          approvalId: requestedApproval.approvalId,
          approvedAt: now
        }
      : previous.mission;
  const handoff =
    action === "handoff"
      ? {
          blocker: payload.blocker ?? payload.reason ?? "blocked",
          attempted: payload.attempted ?? [],
          artifacts: payload.artifacts ?? [],
          nextAction: payload.nextAction ?? payload.next_action,
          createdAt: now
        }
      : previous.handoff;
  const override = validationOverride(payload, now);
  if (
    action === "open-pr" &&
    previous.status === "running" &&
    (!codingTaskValidationPassed(previous) || !codingTaskReviewPassed(previous)) &&
    !override
  ) {
    return {
      ok: false,
      statusCode: 409,
      reason: codingTaskValidationPassed(previous) ? "review_required" : "validation_required"
    };
  }
  const status =
    action === "pause"
      ? "paused"
      : action === "continue"
        ? previous.prNumber
          ? "pr-open"
          : "running"
        : action === "open-pr"
          ? "pr-open"
          : action === "handoff"
            ? "waiting-for-approval"
            : action === "archive"
              ? "archived"
              : previous.status;
  const item = enqueueCodingTaskItems(
    existing,
    {
      status,
      mission,
      validationOverride: override ?? previous.validationOverride,
      latestControl: control,
      handoff,
      items: [
        {
          kind: `control:${action}`,
          status: "approved",
          title: `Coding task control: ${action}`,
          approvalRequired: false,
          payload: control
        }
      ]
    },
    { now }
  );
  return { ok: true, statusCode: 202, taskItem: item, task: item.payload, control };
}

function minutesBetween(leftIso, rightIso) {
  const left = Date.parse(leftIso);
  const right = Date.parse(rightIso);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return 0;
  }
  return Math.max(0, Math.floor((right - left) / 60000));
}

export function reconcileCodingAgentTasks(items = [], payload = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const requestedStaleRunningMinutes = Number.parseInt(
    payload.staleRunningMinutes ?? payload.stale_running_minutes ?? 90,
    10
  );
  const staleRunningMinutes =
    Number.isFinite(requestedStaleRunningMinutes) && requestedStaleRunningMinutes >= 0
      ? requestedStaleRunningMinutes
      : 90;
  const requestedRunQuietMinutes = Number.parseInt(
    payload.runQuietMinutes ?? payload.run_quiet_minutes ?? 10,
    10
  );
  const runQuietMinutes =
    Number.isFinite(requestedRunQuietMinutes) && requestedRunQuietMinutes >= 0
      ? requestedRunQuietMinutes
      : 10;
  const results = [];
  const taskItems = [];

  for (const item of items) {
    const task = existingPayload(item);
    if (TERMINAL_CODING_TASK_STATUSES.has(task.status)) {
      continue;
    }
    const ageMinutes = minutesBetween(task.updatedAt ?? task.createdAt ?? item.ts, now);
    const quietAgeMinutes = minutesBetween(
      task.hermesLastEventAt ?? task.lastEventAt ?? task.updatedAt ?? task.createdAt ?? item.ts,
      now
    );
    const hasRunAnchor = Boolean(task.latestHermesRunId ?? task.hermesRunId);
    let reason;
    let status;
    let hermesRunStatus = task.hermesRunStatus;
    let handoff = task.handoff;

    const staleActiveRun =
      task.hermesRunStatus === "running" &&
      hasRunAnchor &&
      ageMinutes >= staleRunningMinutes &&
      task.status !== "running";
    const stalledActiveRun =
      task.hermesRunStatus === "running" &&
      hasRunAnchor &&
      quietAgeMinutes >= runQuietMinutes &&
      ageMinutes < staleRunningMinutes;

    if (task.status === "running" && !hasRunAnchor) {
      reason = "missing_hermes_run_anchor";
      status = "waiting-for-approval";
      hermesRunStatus = "orphaned";
      handoff = {
        blocker: "missing_hermes_run_anchor",
        attempted: ["startup-reconciliation"],
        artifacts: [],
        nextAction: "inspect runner state before continuing",
        createdAt: now
      };
    } else if (task.status === "running" && ageMinutes >= staleRunningMinutes) {
      reason = "stale_running_task";
      status = "failed";
      hermesRunStatus = "stale";
      handoff = {
        blocker: "stale_running_task",
        attempted: ["startup-reconciliation"],
        artifacts: task.latestHermesRunId ? [`hermes:${task.latestHermesRunId}`] : [],
        nextAction: "inspect logs and resume explicitly",
        createdAt: now
      };
    } else if (stalledActiveRun) {
      reason = "stalled_hermes_run";
      status = "waiting-for-approval";
      hermesRunStatus = "stalled";
      handoff = {
        blocker: "stalled_hermes_run",
        attempted: ["watchdog-reconciliation"],
        artifacts: task.latestHermesRunId ? [`hermes:${task.latestHermesRunId}`] : [],
        nextAction: "inspect Bridge stream and resume explicitly",
        createdAt: now
      };
    } else if (staleActiveRun) {
      reason = "stale_hermes_run";
      status = "waiting-for-approval";
      hermesRunStatus = "stale";
      handoff = {
        blocker: "stale_hermes_run",
        attempted: ["startup-reconciliation"],
        artifacts: task.latestHermesRunId ? [`hermes:${task.latestHermesRunId}`] : [],
        nextAction: "inspect PR update run before continuing",
        createdAt: now
      };
    }

    if (!reason) {
      continue;
    }

    const next = enqueueCodingTaskItems(
      item,
      {
        status,
        hermesRunStatus,
        handoff,
        items: [
          {
            kind: "reconcile-coding-task",
            status: "approved",
            title: `Reconcile coding task: ${reason}`,
            approvalRequired: false,
            payload: {
              reason,
              previousStatus: task.status,
              nextStatus: status,
              ageMinutes,
              quietAgeMinutes,
              providerMutationAllowed: false
            }
          }
        ]
      },
      { now }
    );
    taskItems.push(next);
    results.push({
      taskId: task.id,
      repo: task.repo,
      previousStatus: task.status,
      nextStatus: status,
      reason,
      ageMinutes,
      quietAgeMinutes,
      providerMutationAllowed: false
    });
  }

  const requestId = payload.id ?? payload.requestId ?? payload.request_id;
  const id =
    payload.auditId ??
    payload.audit_id ??
    (requestId
      ? `coding_reconciliation_${slug(requestId)}`
      : `coding_reconciliation_${Date.parse(now) || Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const auditItem = {
    id,
    app: CODING_AGENT_APP_ID,
    type: "coding-reconciliation",
    status: results.length ? "completed" : "noop",
    title: "Coding task reconciliation",
    payload: {
      id,
      requestId,
      checked: items.length,
      reconciled: results.length,
      staleRunningMinutes,
      runQuietMinutes,
      results,
      providerMutationAllowed: false,
      reconciledAt: now
    }
  };

  return {
    ok: true,
    statusCode: 202,
    reconciled: results.length,
    results,
    taskItems,
    auditItem
  };
}

export function summarizeCodingTaskHandoff(existing, payload = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const task = existingPayload(existing);
  if (!task.id) {
    return { ok: false, statusCode: 404, reason: "coding_task_not_found" };
  }

  const queue = task.queue ?? [];
  const blockedQueue = queue.filter((item) =>
    ["blocked", "waiting-for-approval", "failed"].includes(item.status)
  );
  const failedChecks = [
    ...(task.checks?.failed ?? []),
    ...(task.checks?.checkRuns ?? task.checks?.check_runs ?? []).filter((check) =>
      ["failure", "timed_out", "cancelled", "action_required"].includes(
        String(check.conclusion ?? "").toLowerCase()
      )
    )
  ];
  const latestEvents = (task.latestPrEvents ?? []).slice(0, 5).map((event) => ({
    kind: event.kind,
    state: event.state,
    author: event.author,
    summary: event.summary ?? event.body ?? event.name
  }));
  const blocker =
    payload.blocker ??
    task.handoff?.blocker ??
    blockedQueue[0]?.rejectionReason ??
    failedChecks[0]?.name ??
    "operator_attention_required";
  const nextAction =
    payload.nextAction ??
    payload.next_action ??
    task.handoff?.nextAction ??
    (failedChecks.length ? "inspect failed checks and resume explicitly" : "review task state");
  const attempted = [
    ...(task.handoff?.attempted ?? []),
    ...blockedQueue.map((item) => item.kind).filter(Boolean)
  ].filter((item, index, items) => items.indexOf(item) === index);
  const definitionOfDone = (task.mission?.definitionOfDone ?? []).map((item) => ({
    item,
    status: task.mission?.definitionOfDoneStatus?.[item] ?? "unknown"
  }));
  const evidencePacks = (task.evidencePacks ?? []).map((pack) => ({
    runId: pack.runId,
    status: pack.status,
    completedAt: pack.completedAt,
    evidenceDir: pack.evidenceDir,
    eventsPath: pack.eventsPath,
    diffPath: pack.diff?.path,
    finalStatusPath: pack.evidenceDir ? `${pack.evidenceDir}/final-status.json` : undefined
  }));
  const requestId = payload.id ?? payload.requestId ?? payload.request_id;
  const id =
    payload.summaryId ??
    payload.summary_id ??
    `coding_handoff_${slug(task.id)}_${Date.parse(now) || Date.now()}`;
  const summary = [
    task.title,
    `${task.status} in ${task.repo ?? "repo"}`,
    task.prNumber ? `PR #${task.prNumber}` : undefined,
    blocker
  ]
    .filter(Boolean)
    .join(" - ");
  const item = {
    id,
    app: CODING_AGENT_APP_ID,
    type: "coding-handoff-summary",
    status: "ready",
    title: `Handoff: ${task.title}`,
    payload: {
      id,
      requestId,
      taskId: task.id,
      repo: task.repo,
      githubRepo: task.githubRepo,
      prNumber: task.prNumber,
      status: task.status,
      blocker,
      attempted,
      nextAction,
      summary,
      failedChecks,
      blockedQueue: blockedQueue.map((item) => ({
        id: item.id,
        kind: item.kind,
        status: item.status,
        title: item.title,
        rejectionReason: item.rejectionReason
      })),
      latestEvents,
      mission: task.mission,
      definitionOfDone,
      evidencePacks,
      artifacts: [
        task.prUrl,
        task.previewUrl,
        task.worktreeDir,
        ...(task.handoff?.artifacts ?? []),
        ...evidencePacks.flatMap((pack) =>
          [pack.eventsPath, pack.diffPath, pack.finalStatusPath].filter(Boolean)
        )
      ].filter(Boolean),
      providerMutationAllowed: false,
      createdAt: now
    }
  };

  return {
    ok: true,
    statusCode: 202,
    summary: item.payload,
    item
  };
}

export function normalizeCodingAgentFinding(payload = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const title = payload.title ?? "Coding-agent improvement finding";
  const evidence = payload.evidence ?? [];
  const externalId =
    payload.id ??
    payload.externalId ??
    payload.external_id ??
    `finding_${slug(title)}_${Date.parse(now) || Date.now()}`;
  return {
    id: externalId,
    app: CODING_AGENT_APP_ID,
    type: "coding-improvement-finding",
    externalId,
    status: payload.status ?? "draft",
    title,
    detail: payload.summary,
    payload: {
      id: externalId,
      title,
      summary: payload.summary ?? title,
      confidence: payload.confidence ?? "medium",
      affectedSurfaces: payload.affectedSurfaces ?? payload.affected_surfaces ?? [],
      evidence,
      proposedActions: payload.proposedActions ?? payload.proposed_actions ?? [],
      createdAt: payload.createdAt ?? payload.created_at ?? now,
      updatedAt: now
    }
  };
}

export function synthesizeCodingAgentFindings(signals = [], options = {}) {
  const now = options.now ?? new Date().toISOString();
  const grouped = new Map();
  for (const item of signals) {
    const signal = existingPayload(item);
    const key = [signal.repo ?? "global", signal.kind ?? "observation"].join(":");
    grouped.set(key, [...(grouped.get(key) ?? []), signal]);
  }
  return [...grouped.entries()]
    .filter(([, group]) => group.length >= (options.minimumSignals ?? 2))
    .map(([key, group]) =>
      normalizeCodingAgentFinding(
        {
          id: `finding_${slug(key)}`,
          title: `Recurring ${group[0].kind} in ${group[0].repo ?? "coding-agent"}`,
          summary: `${group.length} related coding-agent signals were observed.`,
          confidence: group.length >= 3 ? "high" : "medium",
          affectedSurfaces: [...new Set(group.flatMap((signal) => signal.tags ?? []))],
          evidence: group.map((signal) => ({
            signalId: signal.id,
            source: signal.source,
            summary: signal.summary
          })),
          proposedActions: ["review-recurring-failure"]
        },
        { now }
      )
    );
}

function normalizeGoalMutationAction(action = "create-github-issue") {
  const normalized = String(action ?? "create-github-issue").toLowerCase();
  return CODING_AGENT_GOAL_MUTATION_ACTIONS.includes(normalized) ? normalized : undefined;
}

function goalMutationTarget(action) {
  return (
    {
      "create-github-issue": "github-issue",
      "update-github-issue": "github-issue",
      "write-hermes-memory": "hermes-memory",
      "start-coding-task": "coding-task",
      "post-telegram-message": "telegram-message"
    }[action] ?? "coding-agent"
  );
}

function findingFromMutationPayload(payload = {}) {
  return existingPayload(
    payload.finding ?? payload.sourceFinding ?? payload.source_finding ?? payload
  );
}

function findingEvidenceLines(finding = {}) {
  return (finding.evidence ?? [])
    .slice(0, 5)
    .map((item) =>
      compactList([
        item.signalId ? `signal:${item.signalId}` : undefined,
        item.source,
        item.url,
        item.summary
      ]).join(" - ")
    );
}

function githubIssuePreview(payload, finding, { update = false } = {}) {
  const title = payload.title ?? finding.title ?? "Coding-agent improvement";
  const evidenceLines = findingEvidenceLines(finding);
  const proposedActions =
    payload.proposedActions ?? payload.proposed_actions ?? finding.proposedActions ?? [];
  const body = compactList([
    `Source finding: ${finding.id ?? payload.sourceFindingId ?? payload.source_finding_id ?? "manual"}`,
    "",
    "## Summary",
    payload.summary ?? finding.summary ?? title,
    evidenceLines.length ? "\n## Evidence" : undefined,
    evidenceLines.map((line) => `- ${line}`).join("\n"),
    proposedActions.length ? "\n## Proposed Actions" : undefined,
    proposedActions.map((action) => `- ${action}`).join("\n")
  ]).join("\n");
  return {
    provider: "github",
    operation: update ? "update_issue" : "create_issue",
    repo: payload.repo ?? finding.repo ?? "personal-dashboard",
    issueNumber: update ? (payload.issueNumber ?? payload.issue_number) : undefined,
    title,
    body: update ? undefined : body,
    bodyAppend: update ? body : undefined,
    labels: payload.labels ?? ["coding-agent", "agent-improvement"]
  };
}

function hermesMemoryPreview(payload, finding) {
  const title = payload.title ?? finding.title ?? "Coding-agent improvement";
  const evidenceLines = findingEvidenceLines(finding);
  return {
    provider: "hermes-memory",
    operation: "write_memory",
    namespace: payload.namespace ?? "coding-agent",
    key: payload.key ?? slug(title),
    title,
    summary: payload.summary ?? finding.summary ?? title,
    body: compactList([
      payload.summary ?? finding.summary ?? title,
      evidenceLines.length ? `Evidence: ${evidenceLines.join("; ")}` : undefined
    ]).join("\n")
  };
}

function codingTaskPreview(payload, finding) {
  return {
    provider: "dashboard",
    operation: "start_coding_task",
    repo: payload.repo ?? finding.repo ?? "personal-dashboard",
    title: payload.title ?? finding.title ?? "Coding-agent follow-up",
    request: payload.request ?? payload.summary ?? finding.summary,
    sourceFindingId: finding.id ?? payload.sourceFindingId ?? payload.source_finding_id
  };
}

function telegramMessagePreview(payload, finding) {
  return {
    provider: "telegram",
    operation: "post_message",
    chatId: payload.chatId ?? payload.chat_id,
    threadId: payload.threadId ?? payload.thread_id,
    message:
      payload.message ??
      `${finding.title ?? "Coding-agent finding"}: ${finding.summary ?? ""}`.trim()
  };
}

function goalMutationPreview(action, payload, finding) {
  if (action === "create-github-issue") {
    return githubIssuePreview(payload, finding);
  }
  if (action === "update-github-issue") {
    return githubIssuePreview(payload, finding, { update: true });
  }
  if (action === "write-hermes-memory") {
    return hermesMemoryPreview(payload, finding);
  }
  if (action === "start-coding-task") {
    return codingTaskPreview(payload, finding);
  }
  return telegramMessagePreview(payload, finding);
}

export function planCodingAgentGoalMutation(payload = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const action = normalizeGoalMutationAction(
    payload.action ?? payload.kind ?? payload.mutationType
  );
  if (!action) {
    return { ok: false, statusCode: 400, reason: "unsupported_goal_mutation_action" };
  }
  const finding = findingFromMutationPayload(payload);
  const dryRun = payload.dryRun ?? payload.dry_run ?? true;
  const approved = approvalPresent(payload);
  const blocked = !dryRun && !approved;
  const sourceFindingId = payload.sourceFindingId ?? payload.source_finding_id ?? finding.id;
  const requestId = payload.id ?? payload.requestId ?? payload.request_id;
  const id =
    payload.mutationId ??
    payload.mutation_id ??
    `goal_mutation_${slug(action)}_${slug(sourceFindingId ?? requestId ?? payload.goalId ?? payload.title ?? "manual")}_${Date.parse(now) || Date.now()}`;
  const preview = goalMutationPreview(action, payload, finding);
  const decision = dryRun ? "dry_run" : approved ? "approved" : "approval_required";
  const status = dryRun ? "preview" : approved ? "approved" : "blocked";
  const item = {
    id,
    app: CODING_AGENT_APP_ID,
    type: "coding-goal-mutation",
    externalId: id,
    status,
    title: payload.title ?? `Goal mutation: ${action}`,
    detail: `${preview.provider}:${preview.operation}`,
    payload: {
      id,
      requestId,
      goalId: payload.goalId ?? payload.goal_id,
      sourceFindingId,
      action,
      target: goalMutationTarget(action),
      status,
      dryRun,
      approved,
      approvedBy: payload.approvedBy ?? payload.approved_by,
      approvalId: payload.approvalId ?? payload.approval_id,
      requestedBy: payload.requestedBy ?? payload.requested_by,
      preview,
      audit: {
        decision,
        reason: blocked ? "approval_required" : undefined,
        providerCalled: false,
        createdAt: now
      },
      createdAt: payload.createdAt ?? payload.created_at ?? now,
      updatedAt: now
    }
  };
  return {
    ok: !blocked,
    statusCode: blocked ? 409 : 202,
    blocked,
    reason: blocked ? "approval_required" : undefined,
    mutationItem: item,
    mutation: item.payload
  };
}

export function proposeCodingAgentGoalMutations(payload = {}, options = {}) {
  const finding = findingFromMutationPayload(payload);
  const requestedActions = payload.actions ??
    payload.proposedMutations ?? ["create-github-issue", "write-hermes-memory"];
  const actions = Array.isArray(requestedActions) ? requestedActions : [requestedActions];
  return actions.map((action) =>
    planCodingAgentGoalMutation(
      {
        ...payload,
        finding,
        action,
        dryRun: true,
        sourceFindingId: payload.sourceFindingId ?? payload.source_finding_id ?? finding.id
      },
      options
    )
  );
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
    const riskReview = classifyCodingAgentRisk({
      ...payload,
      action,
      files: payload.files ?? payload.changedFiles
    });
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
    } else if (sideEffect && riskReview.highRisk && !riskApprovalPresent(payload)) {
      status = "blocked";
      rejectionReason = "high_risk_approval_required";
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
      riskReview,
      riskAcceptedBy: payload.riskAcceptedBy ?? payload.risk_accepted_by,
      riskApprovalId: payload.riskApprovalId ?? payload.risk_approval_id,
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

function githubActorFromPayload(payload = {}) {
  const user = payload.pickupActorUser ?? payload.pickup_actor_user ?? payload.user ?? {};
  return {
    login: String(
      payload.pickupActor ??
        payload.pickup_actor ??
        payload.actor ??
        payload.author ??
        user.login ??
        ""
    ).trim(),
    type: String(payload.pickupActorType ?? payload.pickup_actor_type ?? user.type ?? "").trim(),
    association: String(
      payload.pickupActorAssociation ??
        payload.pickup_actor_association ??
        payload.authorAssociation ??
        payload.author_association ??
        ""
    )
      .trim()
      .toUpperCase()
  };
}

function actorIsBot(actor) {
  const login = actor.login.toLowerCase();
  return (
    actor.type.toLowerCase() === "bot" ||
    login.endsWith("[bot]") ||
    login.endsWith("-bot") ||
    login.endsWith("_bot")
  );
}

function actorTrustedForPickup(actor, policy = codingAgentPolicyFromEnv()) {
  const trustedActors = new Set(
    (policy.pickupTrustedActors ?? []).map((item) => item.toLowerCase())
  );
  if (actor.login && trustedActors.has(actor.login.toLowerCase())) {
    return true;
  }
  return TRUSTED_GITHUB_AUTHOR_ASSOCIATIONS.has(actor.association);
}

export function evaluateCodingAgentPrPickup(payload = {}, policy = codingAgentPolicyFromEnv()) {
  const pickupSource = payload.pickupSource ?? payload.pickup_source ?? "dashboard";
  const githubRepo = payload.githubRepo ?? payload.github_repo;
  const repo = githubRepo ?? payload.repo;
  const prNumber = payload.prNumber ?? payload.pr_number;
  const marker =
    payload.pickupMarker ?? payload.pickup_marker ?? payload.commentBody ?? payload.body;
  const markerMatched =
    pickupSource === "dashboard" || commentRequestsCodingAgentPickup(marker, payload.markers);
  const actor = githubActorFromPayload(payload);
  const reasonCodes = [];

  if (!repo) {
    reasonCodes.push("missing_repo");
  } else if (!repoAllowed(repo, policy)) {
    reasonCodes.push("repo_not_allowed");
  }
  if (!prNumber) {
    reasonCodes.push("missing_pr_number");
  }
  if (pickupSource === "github-comment" && !markerMatched) {
    reasonCodes.push("missing_explicit_pickup_marker");
  }
  if (pickupSource === "github-comment") {
    if (!actor.login) {
      reasonCodes.push("missing_pickup_actor");
    } else if (policy.denyBotPickup && actorIsBot(actor)) {
      reasonCodes.push("bot_actor_denied");
    } else if (!actorTrustedForPickup(actor, policy)) {
      reasonCodes.push("actor_not_trusted_for_pickup");
    }
  }

  const ok = reasonCodes.length === 0;
  return {
    ok,
    statusCode: ok
      ? 202
      : reasonCodes.includes("missing_repo") || reasonCodes.includes("missing_pr_number")
        ? 400
        : 403,
    reason: reasonCodes[0],
    reasonCodes,
    pickupSource,
    markerMatched,
    actor: actor.login || undefined,
    actorType: actor.type || undefined,
    actorAssociation: actor.association || undefined,
    actorTrusted: actor.login ? actorTrustedForPickup(actor, policy) && !actorIsBot(actor) : false,
    providerMutationAllowed: false
  };
}

export function normalizeCodingAgentPrPickupAttempt(payload = {}, evaluation = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const githubRepo = payload.githubRepo ?? payload.github_repo;
  const repo = shortRepoName(payload.repo ?? githubRepo ?? "repo");
  const prNumber = payload.prNumber ?? payload.pr_number ?? "unknown";
  const commentId = payload.pickupCommentId ?? payload.pickup_comment_id ?? "manual";
  const id =
    payload.attemptId ??
    payload.attempt_id ??
    `coding_pr_pickup_attempt_${slug(repo)}_${prNumber}_${slug(commentId)}`;
  return {
    id,
    app: CODING_AGENT_APP_ID,
    type: "coding-pr-pickup-attempt",
    status: evaluation.ok ? "accepted" : "rejected",
    title: `PR pickup ${repo}#${prNumber}`,
    payload: {
      id,
      repo,
      githubRepo,
      prNumber: payload.prNumber ?? payload.pr_number,
      pickupSource: evaluation.pickupSource ?? payload.pickupSource ?? payload.pickup_source,
      pickupCommentId: payload.pickupCommentId ?? payload.pickup_comment_id,
      pickupCommentUrl: payload.pickupCommentUrl ?? payload.pickup_comment_url,
      actor: evaluation.actor,
      actorType: evaluation.actorType,
      actorAssociation: evaluation.actorAssociation,
      actorTrusted: evaluation.actorTrusted,
      markerMatched: evaluation.markerMatched,
      accepted: Boolean(evaluation.ok),
      reason: evaluation.reason,
      reasonCodes: evaluation.reasonCodes ?? [],
      providerMutationAllowed: false,
      evaluatedAt: now
    }
  };
}

const PROMPT_INJECTION_PATTERNS = [
  /ignore (all )?(previous|prior|above) (instructions|prompts|rules)/i,
  /system prompt/i,
  /developer (message|instructions)/i,
  /reveal (your )?(secrets|tokens|credentials|instructions)/i,
  /exfiltrat/i,
  /api[_ -]?key|access token|secret/i,
  /rm -rf|sudo |curl .*sh|base64 -d/i
];

function issueActorTrusted(payload = {}, policy = codingAgentPolicyFromEnv()) {
  const actor = githubActorFromPayload({
    actor: payload.author ?? payload.actor,
    authorAssociation: payload.authorAssociation ?? payload.author_association
  });
  return actorTrustedForPickup(actor, policy) && !actorIsBot(actor);
}

export function triageCodingAgentIssue(
  payload = {},
  policy = codingAgentPolicyFromEnv(),
  options = {}
) {
  const now = options.now ?? new Date().toISOString();
  const repo = payload.repo ?? payload.githubRepo ?? payload.github_repo;
  const issueNumber = payload.issueNumber ?? payload.issue_number ?? payload.number;
  const body = String(payload.body ?? payload.description ?? "");
  const title = String(payload.title ?? `GitHub issue #${issueNumber ?? "unknown"}`).trim();
  const injectionMatches = PROMPT_INJECTION_PATTERNS.filter((pattern) => pattern.test(body)).map(
    (pattern) => pattern.source
  );
  const trustedActor = issueActorTrusted(payload, policy);
  const reasonCodes = [];

  if (!repo) {
    reasonCodes.push("missing_repo");
  } else if (!repoAllowed(repo, policy)) {
    reasonCodes.push("repo_not_allowed");
  }
  if (!issueNumber) {
    reasonCodes.push("missing_issue_number");
  }
  if (!trustedActor) {
    reasonCodes.push("untrusted_issue_author");
  }
  if (injectionMatches.length) {
    reasonCodes.push("prompt_injection_risk");
  }

  const highRisk = classifyCodingAgentRisk({
    repo,
    title,
    request: `${title}\n\n${body}`,
    files: payload.files ?? payload.changedFiles ?? payload.changed_files
  });
  if (highRisk.highRisk) {
    reasonCodes.push("high_risk_issue_scope");
  }

  const decision = reasonCodes.length === 0 ? "draft-task" : "needs-approval";
  const issueKey = issueNumber ?? (Date.parse(now) || Date.now());
  const id = payload.id ?? `coding_issue_triage_${slug(shortRepoName(repo ?? "repo"))}_${issueKey}`;
  const item = {
    id,
    app: CODING_AGENT_APP_ID,
    type: "coding-issue-triage",
    status: decision,
    title: `Issue triage: ${title}`,
    payload: {
      id,
      source: payload.source ?? "github-issue",
      repo: shortRepoName(repo),
      githubRepo: payload.githubRepo ?? payload.github_repo ?? repo,
      issueNumber,
      issueUrl: payload.issueUrl ?? payload.issue_url ?? payload.html_url,
      title,
      author: payload.author ?? payload.actor,
      authorAssociation: payload.authorAssociation ?? payload.author_association,
      trustedActor,
      promptInjectionRisk: injectionMatches.length > 0,
      promptInjectionMatches: injectionMatches,
      riskReview: highRisk,
      decision,
      reasonCodes,
      providerMutationAllowed: false,
      taskDraft:
        decision === "draft-task"
          ? {
              repo: shortRepoName(repo),
              title,
              request: body || title,
              sourceIssueNumber: issueNumber,
              sourceIssueUrl: payload.issueUrl ?? payload.issue_url ?? payload.html_url
            }
          : undefined,
      evaluatedAt: now
    }
  };

  return {
    ok: decision === "draft-task",
    statusCode: decision === "draft-task" ? 202 : 409,
    blocked: decision !== "draft-task",
    reason: reasonCodes[0],
    triage: item.payload,
    item
  };
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
  const pickupPolicy = evaluateCodingAgentPrPickup(payload, policy);
  const pickupAttemptItem = normalizeCodingAgentPrPickupAttempt(payload, pickupPolicy, { now });
  if (!pickupPolicy.ok) {
    return {
      ok: false,
      statusCode: pickupPolicy.statusCode,
      reason: pickupPolicy.reason,
      policy: pickupPolicy,
      pickupAttemptItem
    };
  }
  if (existing?.payload?.status === "archived") {
    const archivedPolicy = {
      ...pickupPolicy,
      ok: false,
      statusCode: 409,
      reason: "coding_task_archived",
      reasonCodes: ["coding_task_archived"]
    };
    return {
      ok: false,
      statusCode: 409,
      reason: "coding_task_archived",
      policy: archivedPolicy,
      pickupAttemptItem: normalizeCodingAgentPrPickupAttempt(payload, archivedPolicy, { now })
    };
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

  return {
    ok: true,
    statusCode: existing ? 200 : 202,
    taskItem: item,
    task: item.payload,
    policy: pickupPolicy,
    pickupAttemptItem
  };
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
