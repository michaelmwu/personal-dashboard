import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import {
  codingAgentPolicyFromEnv,
  codingAgentExecutorPayload,
  classifyCodingAgentRisk,
  commentRequestsCodingAgentPickup,
  evaluateCodingAgentPrPickup,
  relevantCodingAgentRegressionMemory,
  shortRepoName
} from "../packages/integrations/coding-agent.mjs";

const execFileAsync = promisify(execFile);
const VALIDATION_OUTPUT_TAIL_CHARS = 6000;

function outputTail(value, maxChars = VALIDATION_OUTPUT_TAIL_CHARS) {
  const text = String(value ?? "");
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

export function splitValidationCommand(command) {
  const text = String(command ?? "").trim();
  const tokens = [];
  let current = "";
  let quote;
  let escaping = false;
  for (const char of text) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) {
    throw new Error("validation_command_unclosed_quote");
  }
  if (escaping) {
    current += "\\";
  }
  if (current) {
    tokens.push(current);
  }
  if (!tokens.length) {
    throw new Error("validation_command_empty");
  }
  if (
    tokens.some(
      (token) =>
        ["&&", "||", "|", ";", ">", ">>", "<"].includes(token) ||
        token.includes("$(") ||
        token.includes("`")
    )
  ) {
    throw new Error("validation_command_shell_operator_rejected");
  }
  return { executable: tokens[0], args: tokens.slice(1) };
}

function envNumber(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function envBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function dashboardBaseUrl() {
  return (process.env.PERSONAL_DASHBOARD_API_BASE_URL ?? "http://127.0.0.1:8810").replace(
    /\/$/,
    ""
  );
}

function dashboardEventUrl(source) {
  return `${dashboardBaseUrl()}/api/integrations/${source}/events`;
}

function envList(name, env = process.env) {
  return String(env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function asiaDealsUrl() {
  const baseUrl = process.env.ASIA_TRAVEL_DEALS_API_BASE_URL;
  if (!baseUrl) {
    throw new Error("ASIA_TRAVEL_DEALS_API_BASE_URL is required for Asia deal polling.");
  }
  return `${baseUrl.replace(/\/$/, "")}/deals`;
}

function asiaDealPayload(deal) {
  return {
    id: deal.id,
    dealGroupId: deal.deal_group_id,
    headline: deal.headline,
    originAirports: deal.origin_airports,
    destinationAirports: deal.destination_airports,
    cabin: deal.cabin,
    priceUsd: deal.price_usd,
    dealScore: deal.deal_score,
    status: deal.status,
    updatedAt: deal.updated_at
  };
}

async function postDashboardEvent(source, payload) {
  const response = await fetch(dashboardEventUrl(source), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(process.env.PERSONAL_DASHBOARD_API_TOKEN)
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Dashboard event POST failed with HTTP ${response.status}`);
  }
  return response.json();
}

async function postDashboardAction(path, payload = {}) {
  const response = await fetch(`${dashboardBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(process.env.PERSONAL_DASHBOARD_API_TOKEN)
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Dashboard POST ${path} failed with HTTP ${response.status}`);
  }
  return response.json();
}

async function getDashboardJson(path) {
  const response = await fetch(`${dashboardBaseUrl()}${path}`, {
    headers: authHeaders(process.env.PERSONAL_DASHBOARD_API_TOKEN)
  });
  if (!response.ok) {
    throw new Error(`Dashboard GET ${path} failed with HTTP ${response.status}`);
  }
  return response.json();
}

function validationCommandsForTask(task) {
  return Array.isArray(task.mission?.validationCommands) ? task.mission.validationCommands : [];
}

async function runValidationCommand(command, task, options = {}) {
  const startedAt = Date.now();
  let parsed;
  try {
    parsed = splitValidationCommand(command);
  } catch (error) {
    return {
      command,
      cwd: task.worktreeDir,
      exitCode: 127,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  try {
    const result = await (options.command ?? execFileAsync)(parsed.executable, parsed.args, {
      cwd: task.worktreeDir,
      timeout: options.timeoutMs ?? envNumber("CODING_AGENT_VALIDATION_TIMEOUT_MS", 120000),
      maxBuffer: options.maxBuffer ?? 1024 * 1024
    });
    return {
      command,
      executable: parsed.executable,
      args: parsed.args,
      cwd: task.worktreeDir,
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      stdoutTail: outputTail(result.stdout),
      stderrTail: outputTail(result.stderr)
    };
  } catch (error) {
    return {
      command,
      executable: parsed.executable,
      args: parsed.args,
      cwd: task.worktreeDir,
      exitCode: Number.isFinite(error?.code) ? error.code : 1,
      signal: error?.signal,
      durationMs: Date.now() - startedAt,
      stdoutTail: outputTail(error?.stdout),
      stderrTail: outputTail(error?.stderr),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function runCodingTaskValidation(task, options = {}) {
  const commands = validationCommandsForTask(task);
  const attempt = (Number.parseInt(task.validationAttempts ?? 0, 10) || 0) + 1;
  if (!task.worktreeDir) {
    return {
      taskId: task.id,
      status: "failed",
      attempt,
      runId: task.latestHermesRunId ?? task.hermesRunId,
      commands: [
        {
          command: "(resolve task worktree)",
          exitCode: 1,
          error: "missing_worktree_dir"
        }
      ],
      summary: "Validation failed because the task has no worktreeDir."
    };
  }
  if (!commands.length) {
    return {
      taskId: task.id,
      status: "skipped",
      attempt,
      runId: task.latestHermesRunId ?? task.hermesRunId,
      commands: [],
      summary: "No mission.validationCommands were approved for this task."
    };
  }

  const results = [];
  for (const command of commands) {
    const result = await runValidationCommand(command, task, options);
    results.push(result);
    if (result.exitCode !== 0) {
      break;
    }
  }
  const passed =
    results.length === commands.length && results.every((result) => result.exitCode === 0);
  return {
    taskId: task.id,
    status: passed ? "passed" : "failed",
    attempt,
    runId: task.latestHermesRunId ?? task.hermesRunId,
    commands: results,
    summary: passed ? "All validation commands passed." : "One or more validation commands failed."
  };
}

function reviewGatewayConfig(env = process.env, task = {}) {
  const baseUrl = String(env.CODING_AGENT_REVIEW_GATEWAY_URL ?? "").replace(/\/$/, "");
  const apiKey = env.CODING_AGENT_REVIEW_GATEWAY_KEY;
  const reviewer = task.modelPolicy?.reviewer;
  return {
    baseUrl,
    apiKey,
    model: env.CODING_AGENT_REVIEW_MODEL ?? reviewer?.model,
    reviewer
  };
}

async function runHarnessReview(input, config, task, options = {}) {
  const command = options.command ?? execFileAsync;
  const prompt = JSON.stringify(input);
  if (config.reviewer?.harness === "codex") {
    const result = await command(
      "codex",
      ["exec", "--sandbox", "read-only", "--cd", task.worktreeDir, "--model", config.model, prompt],
      {
        cwd: task.worktreeDir,
        timeout: options.timeoutMs ?? envNumber("CODING_AGENT_REVIEW_TIMEOUT_MS", 120000),
        maxBuffer: 2 * 1024 * 1024
      }
    );
    return parseReviewResponse(result.stdout);
  }
  if (config.reviewer?.harness === "claude") {
    const result = await command(
      "claude",
      ["--print", "--permission-mode", "plan", "--model", config.model, prompt],
      {
        cwd: task.worktreeDir,
        timeout: options.timeoutMs ?? envNumber("CODING_AGENT_REVIEW_TIMEOUT_MS", 120000),
        maxBuffer: 2 * 1024 * 1024
      }
    );
    return parseReviewResponse(result.stdout);
  }
  throw new Error(`unsupported_review_harness_${config.reviewer?.harness ?? "unknown"}`);
}

function parseReviewResponse(content) {
  const parsed = typeof content === "string" ? JSON.parse(content) : content;
  return {
    findings: Array.isArray(parsed?.findings) ? parsed.findings : [],
    definitionOfDone: Array.isArray(parsed?.definitionOfDone) ? parsed.definitionOfDone : [],
    summary: parsed?.summary
  };
}

export async function runCodingTaskReview(task, options = {}) {
  const risk =
    task.riskReview?.risk ??
    classifyCodingAgentRisk({
      title: task.title,
      prompt: task.prompt,
      files: task.changedFiles
    });
  const attempt = (Number.parseInt(task.reviewAttempts ?? 0, 10) || 0) + 1;
  const baseBranch = task.baseBranch ?? "origin/main";
  const reviewerConfig = reviewGatewayConfig(options.env ?? process.env, task);
  const reviewBase = {
    taskId: task.id,
    runId: task.latestHermesRunId ?? task.hermesRunId,
    attempt,
    riskTier: risk.level,
    model: reviewerConfig.reviewer
  };
  if (!task.worktreeDir || !task.mission) {
    return {
      ...reviewBase,
      status: "failed",
      findings: [],
      definitionOfDone: [],
      summary: "Missing task worktree or approved mission."
    };
  }
  if (
    reviewerConfig.reviewer &&
    task.modelPolicy?.executor?.harness === reviewerConfig.reviewer.harness
  ) {
    return {
      ...reviewBase,
      status: "failed",
      findings: [],
      definitionOfDone: [],
      summary: "reviewer_must_use_a_different_harness_than_executor"
    };
  }
  try {
    const diffResult = await (options.command ?? execFileAsync)(
      "git",
      ["diff", "--no-ext-diff", `${baseBranch}...HEAD`],
      {
        cwd: task.worktreeDir,
        timeout: options.timeoutMs ?? envNumber("CODING_AGENT_REVIEW_TIMEOUT_MS", 120000),
        maxBuffer: 2 * 1024 * 1024
      }
    );
    const input = {
      mission: task.mission,
      diff: outputTail(diffResult.stdout, options.maxDiffChars ?? 50000),
      riskTier: risk.level,
      feedback: task.reviewRequest?.feedback,
      instructions:
        "Review against the mission. Return JSON only: {summary, findings:[{severity,file,line,summary,failureScenario}], definitionOfDone:[{item,verdict,rationale}]}. You are a reviewer: never edit code or propose a patch."
    };
    let reviewed;
    if (options.reviewer) {
      reviewed = await options.reviewer(input, reviewBase);
    } else if ((options.env ?? process.env).CODING_AGENT_REVIEW_USE_HARNESS === "true") {
      reviewed = await runHarnessReview(input, reviewerConfig, task, options);
    } else {
      if (!reviewerConfig.baseUrl || !reviewerConfig.apiKey || !reviewerConfig.model) {
        throw new Error("missing_coding_agent_review_gateway_configuration");
      }
      const response = await fetch(`${reviewerConfig.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${reviewerConfig.apiKey}`
        },
        body: JSON.stringify({
          model: reviewerConfig.model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: "You are an adversarial coding reviewer. Return valid JSON only."
            },
            { role: "user", content: JSON.stringify(input) }
          ]
        })
      });
      if (!response.ok) {
        throw new Error(`review_gateway_http_${response.status}`);
      }
      const body = await response.json();
      reviewed = parseReviewResponse(body.choices?.[0]?.message?.content);
    }
    const result = parseReviewResponse(reviewed);
    const blockerCount = result.findings.filter((finding) => finding.severity === "blocker").length;
    return {
      ...reviewBase,
      ...result,
      status: blockerCount ? "blocked" : result.findings.length ? "findings" : "clean"
    };
  } catch (error) {
    return {
      ...reviewBase,
      status: "failed",
      findings: [],
      definitionOfDone: [],
      summary: error instanceof Error ? error.message : String(error)
    };
  }
}

async function readJsonFeed(filePath) {
  const payload = JSON.parse(await readFile(filePath, "utf8"));
  return Array.isArray(payload) ? payload : [payload];
}

async function ingestJsonFeed({ source, envName, fallbackEnvNames = [] }) {
  const envNames = [envName, ...fallbackEnvNames];
  const configuredEnvName = envNames.find((name) => process.env[name]);
  const filePath = configuredEnvName ? process.env[configuredEnvName] : undefined;
  if (!filePath) {
    return { source, skipped: true, reason: `${envNames.join(" or ")} is not configured` };
  }

  const items = await readJsonFeed(filePath);
  let upserts = 0;
  for (const item of items) {
    await postDashboardEvent(source, item);
    upserts += 1;
  }
  return { source, fetched: items.length, upserts };
}

export async function runIngestion(source, task) {
  try {
    return { source, ...(await task()) };
  } catch (error) {
    return {
      source,
      error: true,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function pollAsiaTravelDeals() {
  const response = await fetch(asiaDealsUrl(), {
    headers: authHeaders(process.env.ASIA_TRAVEL_DEALS_API_TOKEN)
  });
  if (!response.ok) {
    throw new Error(`AsiaTravelDeals /deals poll failed with HTTP ${response.status}`);
  }

  const deals = await response.json();
  let upserts = 0;
  for (const deal of deals) {
    await postDashboardEvent("asia-travel-deals", asiaDealPayload(deal));
    upserts += 1;
  }
  return { fetched: deals.length, upserts };
}

function githubRepoForTask(task, env = process.env) {
  const repo = task.githubRepo ?? task.github_repo ?? task.repo;
  if (!repo) {
    return undefined;
  }
  if (String(repo).includes("/")) {
    return String(repo);
  }
  const owner = env.CODING_AGENT_GITHUB_OWNER ?? env.GITHUB_OWNER;
  return owner ? `${owner}/${repo}` : undefined;
}

function isoTime(value) {
  const date = value ? new Date(value) : undefined;
  return date && !Number.isNaN(date.valueOf()) ? date.toISOString() : undefined;
}

function eventTime(event) {
  return isoTime(event.completed_at ?? event.submitted_at ?? event.updated_at ?? event.created_at);
}

function eventKey(event) {
  return `${event.kind}:${event.id ?? event.node_id ?? event.url ?? eventTime(event)}`;
}

function cursorTime(cursor) {
  return isoTime(cursor?.updatedAt ?? cursor?.updated_at);
}

function afterCursor(event, cursor) {
  const since = cursorTime(cursor);
  const time = eventTime(event);
  if (!since || !time) {
    return true;
  }
  return time > since;
}

function newestCursor(events, previousCursor) {
  const newest = events.map(eventTime).filter(Boolean).sort().at(-1);
  return {
    updatedAt: newest ?? cursorTime(previousCursor) ?? new Date().toISOString(),
    eventKeys: events.map(eventKey)
  };
}

function actionablePrEvents(events) {
  return events.filter((event) => {
    if (event.kind === "review") {
      return ["CHANGES_REQUESTED", "COMMENTED"].includes(String(event.state ?? "").toUpperCase());
    }
    if (event.kind === "check") {
      return ["failure", "timed_out", "cancelled", "action_required"].includes(
        String(event.conclusion ?? "").toLowerCase()
      );
    }
    return event.kind === "comment";
  });
}

function normalizeReview(review) {
  return {
    kind: "review",
    id: review.id,
    state: review.state,
    body: review.body,
    author: review.user?.login,
    submitted_at: review.submitted_at,
    html_url: review.html_url
  };
}

function normalizeComment(comment) {
  return {
    kind: "comment",
    id: comment.id,
    body: comment.body,
    author: comment.user?.login,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    path: comment.path,
    line: comment.line ?? comment.original_line,
    html_url: comment.html_url
  };
}

export function dedupePrFeedbackAgainstInternalReview(events = [], review = {}) {
  const findingKeys = new Set(
    (review.findings ?? [])
      .filter((finding) => finding.file && Number.isFinite(finding.line))
      .map((finding) => `${finding.file}:${finding.line}`)
  );
  if (!findingKeys.size) {
    return { actionable: events, deduplicated: [] };
  }
  const actionable = [];
  const deduplicated = [];
  for (const event of events) {
    const key =
      event.path && Number.isFinite(event.line) ? `${event.path}:${event.line}` : undefined;
    if (key && findingKeys.has(key)) {
      deduplicated.push({ ...event, duplicateOfInternalFinding: key });
    } else {
      actionable.push(event);
    }
  }
  return { actionable, deduplicated };
}

function normalizeCheckRun(check) {
  return {
    kind: "check",
    id: check.id,
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
    started_at: check.started_at,
    completed_at: check.completed_at,
    html_url: check.html_url
  };
}

export async function ghJson(path, { command = execFileAsync } = {}) {
  const { stdout } = await command("gh", ["api", path], {
    maxBuffer: 10 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

function codingAgentPickupRepos(env = process.env) {
  const owner = env.CODING_AGENT_GITHUB_OWNER;
  return envList("CODING_AGENT_PICKUP_REPOS", env)
    .concat(envList("CODING_AGENT_ALLOWED_REPOS", env))
    .map((repo) => (repo.includes("/") || !owner ? repo : `${owner}/${repo}`))
    .filter((repo) => repo.includes("/"))
    .filter((repo, index, repos) => repos.indexOf(repo) === index);
}

function codingAgentIssueTriageRepos(env = process.env) {
  const owner = env.CODING_AGENT_GITHUB_OWNER;
  const configured = envList("CODING_AGENT_ISSUE_TRIAGE_REPOS", env);
  const repos = configured.length
    ? configured
    : envList("CODING_AGENT_PICKUP_REPOS", env).concat(envList("CODING_AGENT_ALLOWED_REPOS", env));
  return repos
    .map((repo) => (repo.includes("/") || !owner ? repo : `${owner}/${repo}`))
    .filter((repo) => repo.includes("/"))
    .filter((repo, index, candidates) => candidates.indexOf(repo) === index);
}

function prNumberFromIssueComment(comment) {
  const match = String(comment.issue_url ?? comment.html_url ?? "").match(
    /\/issues\/(\d+)(?:$|[#?])/
  );
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function codingTaskPrKeys(task, env = process.env) {
  const repo = task.githubRepo ?? task.github_repo ?? githubRepoForTask(task, env);
  const shortRepo = shortRepoName(task.repo ?? repo);
  const prNumber = task.prNumber ?? task.pr_number;
  return [`${repo}:${prNumber}`, `${shortRepo}:${prNumber}`].filter(
    (key) => !key.includes("undefined")
  );
}

function codingIssueTriageKeys(item) {
  const payload = item.payload ?? item;
  const repo = payload.githubRepo ?? payload.github_repo ?? payload.repo;
  const shortRepo = shortRepoName(payload.repo ?? repo);
  const issueNumber = payload.issueNumber ?? payload.issue_number;
  return [`${repo}:${issueNumber}`, `${shortRepo}:${issueNumber}`].filter(
    (key) => !key.includes("undefined")
  );
}

function pickupPayloadFromPr({ repo, prNumber, pr, comment }) {
  return {
    repo: shortRepoName(repo),
    githubRepo: repo,
    prNumber,
    title: pr.title ?? `Pick up PR #${prNumber}`,
    branch: pr.head?.ref,
    baseBranch: pr.base?.ref,
    prUrl: pr.html_url,
    headSha: pr.head?.sha,
    status: "pr-open",
    pickupSource: "github-comment",
    pickupMarker: comment.body,
    pickupCommentId: String(comment.id),
    pickupCommentUrl: comment.html_url,
    pickupActor: comment.user?.login,
    pickupActorType: comment.user?.type,
    pickupActorAssociation: comment.author_association
  };
}

function pickupPolicyPayloadFromComment({ repo, prNumber, comment }) {
  return {
    repo: shortRepoName(repo),
    githubRepo: repo,
    prNumber,
    pickupSource: "github-comment",
    pickupMarker: comment.body,
    pickupCommentId: String(comment.id),
    pickupCommentUrl: comment.html_url,
    pickupActor: comment.user?.login,
    pickupActorType: comment.user?.type,
    pickupActorAssociation: comment.author_association
  };
}

function issueTriagePayloadFromIssue({ repo, issue }) {
  return {
    repo: shortRepoName(repo),
    githubRepo: repo,
    issueNumber: issue.number,
    title: issue.title,
    body: issue.body,
    issueUrl: issue.html_url,
    author: issue.user?.login,
    authorAssociation: issue.author_association,
    source: "github-issue"
  };
}

export async function discoverCodingAgentPrPickups(options = {}) {
  const env = options.env ?? process.env;
  const repos = options.repos ?? codingAgentPickupRepos(env);
  if (!repos.length) {
    return { skipped: true, reason: "no_pickup_repos_configured", pickedUp: 0, results: [] };
  }

  const tasksResponse =
    options.tasksResponse ??
    (await getDashboardJson("/api/apps/coding-agent/tasks?includeArchived=true"));
  const managedKeys = new Set(
    (tasksResponse.tasks ?? []).flatMap((task) => codingTaskPrKeys(task, env))
  );
  const command = options.command ?? execFileAsync;
  const policy = options.policy ?? codingAgentPolicyFromEnv(env);
  const postPickup =
    options.postPickup ??
    ((payload) => postDashboardAction("/api/apps/coding-agent/pr-pickup", payload));
  const results = [];

  for (const repo of repos) {
    const comments = await ghJson(`repos/${repo}/issues/comments?per_page=100`, { command });
    for (const comment of comments.filter((item) => commentRequestsCodingAgentPickup(item.body))) {
      const prNumber = prNumberFromIssueComment(comment);
      if (!prNumber) {
        results.push({ repo, commentId: comment.id, skipped: true, reason: "missing_pr_number" });
        continue;
      }
      const pickupPolicy = evaluateCodingAgentPrPickup(
        pickupPolicyPayloadFromComment({ repo, prNumber, comment }),
        policy
      );
      if (!pickupPolicy.ok) {
        results.push({
          repo,
          prNumber,
          commentId: comment.id,
          skipped: true,
          reason: pickupPolicy.reason,
          reasonCodes: pickupPolicy.reasonCodes,
          providerMutationAllowed: false
        });
        continue;
      }
      if (
        managedKeys.has(`${repo}:${prNumber}`) ||
        managedKeys.has(`${shortRepoName(repo)}:${prNumber}`)
      ) {
        results.push({
          repo,
          prNumber,
          commentId: comment.id,
          skipped: true,
          reason: "already_managed"
        });
        continue;
      }

      let pr;
      try {
        pr = await ghJson(`repos/${repo}/pulls/${prNumber}`, { command });
      } catch (_error) {
        results.push({
          repo,
          prNumber,
          commentId: comment.id,
          skipped: true,
          reason: "not_pull_request"
        });
        continue;
      }
      if (String(pr.state ?? "").toLowerCase() !== "open") {
        results.push({
          repo,
          prNumber,
          commentId: comment.id,
          skipped: true,
          reason: "pr_not_open"
        });
        continue;
      }

      const payload = pickupPayloadFromPr({ repo, prNumber, pr, comment });
      const pickup = await postPickup(payload);
      managedKeys.add(`${repo}:${prNumber}`);
      managedKeys.add(`${shortRepoName(repo)}:${prNumber}`);
      results.push({
        repo,
        prNumber,
        commentId: comment.id,
        pickedUp: true,
        pickup,
        taskId: pickup.task?.id
      });
    }
  }

  return {
    repoCount: repos.length,
    pickedUp: results.filter((result) => result.pickedUp).length,
    results
  };
}

export async function discoverCodingAgentIssueTriage(options = {}) {
  const env = options.env ?? process.env;
  const repos = options.repos ?? codingAgentIssueTriageRepos(env);
  if (!repos.length) {
    return { skipped: true, reason: "no_issue_triage_repos_configured", triaged: 0, results: [] };
  }

  const itemsResponse =
    options.itemsResponse ??
    (await getDashboardJson("/api/apps/coding-agent/items?type=coding-issue-triage"));
  const triagedKeys = new Set((itemsResponse.items ?? []).flatMap(codingIssueTriageKeys));
  const command = options.command ?? execFileAsync;
  const postTriage =
    options.postTriage ??
    ((payload) => postDashboardAction("/api/apps/coding-agent/issue-triage", payload));
  const results = [];

  for (const repo of repos) {
    const issues = await ghJson(
      `repos/${repo}/issues?state=open&per_page=100&sort=created&direction=desc`,
      { command }
    );
    for (const issue of issues) {
      if (issue.pull_request) {
        results.push({
          repo,
          issueNumber: issue.number,
          skipped: true,
          reason: "pull_request_not_issue"
        });
        continue;
      }
      if (!issue.number) {
        results.push({ repo, skipped: true, reason: "missing_issue_number" });
        continue;
      }
      if (
        triagedKeys.has(`${repo}:${issue.number}`) ||
        triagedKeys.has(`${shortRepoName(repo)}:${issue.number}`)
      ) {
        results.push({
          repo,
          issueNumber: issue.number,
          skipped: true,
          reason: "already_triaged"
        });
        continue;
      }

      const payload = issueTriagePayloadFromIssue({ repo, issue });
      const triage = await postTriage(payload);
      triagedKeys.add(`${repo}:${issue.number}`);
      triagedKeys.add(`${shortRepoName(repo)}:${issue.number}`);
      results.push({
        repo,
        issueNumber: issue.number,
        triaged: true,
        accepted: triage.accepted,
        blocked: triage.blocked,
        reason: triage.reason,
        triage
      });
    }
  }

  return {
    repoCount: repos.length,
    triaged: results.filter((result) => result.triaged).length,
    results
  };
}

export async function fetchCodingTaskPrSnapshot(task, options = {}) {
  const repo = githubRepoForTask(task, options.env ?? process.env);
  const prNumber = task.prNumber ?? task.pr_number;
  if (!repo || !prNumber) {
    return { skipped: true, reason: repo ? "missing_pr_number" : "missing_github_repo" };
  }

  const command = options.command ?? execFileAsync;
  const pr = await ghJson(`repos/${repo}/pulls/${prNumber}`, { command });
  const [reviews, issueComments, reviewComments] = await Promise.all([
    ghJson(`repos/${repo}/pulls/${prNumber}/reviews`, { command }),
    ghJson(`repos/${repo}/issues/${prNumber}/comments`, { command }),
    ghJson(`repos/${repo}/pulls/${prNumber}/comments`, { command })
  ]);
  let checkRuns = [];
  if (pr.head?.sha) {
    const checks = await ghJson(`repos/${repo}/commits/${pr.head.sha}/check-runs`, { command });
    checkRuns = checks.check_runs ?? [];
  }

  const events = [
    ...reviews.map(normalizeReview),
    ...issueComments.map(normalizeComment),
    ...reviewComments.map(normalizeComment),
    ...checkRuns.map(normalizeCheckRun)
  ].filter((event) => afterCursor(event, task.githubCursor));
  const actionable = actionablePrEvents(events);
  const failedChecks = checkRuns.filter((check) =>
    ["failure", "timed_out", "cancelled", "action_required"].includes(
      String(check.conclusion ?? "").toLowerCase()
    )
  );
  const latestChangeRequest = reviews
    .filter((review) => String(review.state ?? "").toUpperCase() === "CHANGES_REQUESTED")
    .sort((left, right) => String(right.submitted_at).localeCompare(String(left.submitted_at)))[0];

  return {
    repo,
    prNumber,
    prState: pr.merged_at ? "MERGED" : pr.state?.toUpperCase(),
    branch: pr.head?.ref,
    headSha: pr.head?.sha,
    prUrl: pr.html_url,
    reviewState: latestChangeRequest ? "CHANGES_REQUESTED" : undefined,
    checks: {
      conclusion: failedChecks.length ? "failure" : "success",
      failed: failedChecks.map((check) => ({
        id: check.id,
        name: check.name,
        conclusion: check.conclusion,
        html_url: check.html_url
      }))
    },
    events,
    actionable,
    cursor: newestCursor(events, task.githubCursor)
  };
}

async function dispatchCodingTaskUpdate(task, snapshot) {
  if (!snapshot.actionable.length) {
    return { dispatched: false, reason: "no_actionable_pr_events" };
  }
  const memoryResponse = await getDashboardJson(
    "/api/apps/coding-agent/items?type=coding-regression-memory"
  ).catch(() => ({ items: [] }));
  const regressionMemory = relevantCodingAgentRegressionMemory(task, memoryResponse.items ?? [], {
    repo: snapshot.repo,
    prNumber: snapshot.prNumber,
    events: snapshot.actionable,
    checks: snapshot.checks
  });
  const executorPayload = codingAgentExecutorPayload(task, {
    repo: snapshot.repo,
    prNumber: snapshot.prNumber,
    events: snapshot.actionable,
    checks: snapshot.checks,
    cursor: snapshot.cursor,
    regressionMemory
  });
  return postDashboardAction("/api/hermes/actions", {
    capabilityId: "update-coding-task",
    origin: "dashboard",
    idempotencyKey: `coding-agent:${task.id}:${executorPayload.mode}:${snapshot.cursor.updatedAt}`,
    payload: executorPayload
  });
}

async function dispatchCodingTaskValidationRepair(task, validation, options = {}) {
  const maxRepairAttempts =
    options.maxRepairAttempts ?? envNumber("CODING_AGENT_MAX_REPAIR_ATTEMPTS", 3);
  const nextRepairAttempt = (Number.parseInt(task.repairAttempts ?? 0, 10) || 0) + 1;
  if (validation.status !== "failed" || nextRepairAttempt >= maxRepairAttempts) {
    return { dispatched: false, reason: "repair_not_allowed" };
  }
  const executorPayload = codingAgentExecutorPayload(task, {
    mode: "validation-repair",
    events: [
      {
        kind: "validation",
        status: validation.status,
        attempt: validation.attempt,
        commands: validation.commands
      }
    ],
    checks: {
      failed: validation.commands
        .filter((command) => command.exitCode !== 0)
        .map((command) => ({
          name: command.command,
          conclusion: "failure",
          summary: command.stderrTail || command.stdoutTail || command.error
        }))
    }
  });
  return postDashboardAction("/api/hermes/actions", {
    capabilityId: "update-coding-task",
    origin: "dashboard",
    idempotencyKey: `coding-agent:${task.id}:validation-repair:${validation.id}`,
    payload: executorPayload
  });
}

async function dispatchCodingTaskReviewRepair(task, review, options = {}) {
  const maxRepairAttempts =
    options.maxRepairAttempts ?? envNumber("CODING_AGENT_MAX_REPAIR_ATTEMPTS", 3);
  const nextRepairAttempt = (Number.parseInt(task.repairAttempts ?? 0, 10) || 0) + 1;
  if (review.status !== "blocked" || nextRepairAttempt >= maxRepairAttempts) {
    return { dispatched: false, reason: "repair_not_allowed" };
  }
  const executorPayload = codingAgentExecutorPayload(task, {
    mode: "review-repair",
    events: [{ kind: "coding-review", ...review }],
    checks: {
      failed: review.findings
        .filter((finding) => finding.severity === "blocker")
        .map((finding) => ({
          name: `${finding.file ?? "task"}:${finding.line ?? "?"}`,
          conclusion: "failure",
          summary: finding.summary || finding.failureScenario
        }))
    }
  });
  return postDashboardAction("/api/hermes/actions", {
    capabilityId: "update-coding-task",
    origin: "dashboard",
    idempotencyKey: `coding-agent:${task.id}:review-repair:${review.id ?? review.attempt}`,
    payload: executorPayload
  });
}

async function dispatchCodingTaskDeepReview(task, review, _options = {}) {
  if (review.riskTier !== "high") {
    return { dispatched: false, reason: "standard_review_sufficient" };
  }
  const prompt = [
    "You are the high-risk coding-task reviewer, not an executor.",
    "Do not edit files, run mutating commands, commit, push, or create a PR.",
    `Review only the registered worktree: ${task.worktreeDir ?? "(missing)"}.`,
    "Inspect the approved mission and current diff, then return concise blocker/non-blocker findings with file, line, and failure scenario.",
    "The deterministic review result remains the PR gate; this session is an adversarial deep-dive evidence source."
  ].join("\n");
  return postDashboardAction("/api/hermes/actions", {
    capabilityId: "deep-review-coding-task",
    origin: "dashboard",
    idempotencyKey: `coding-agent:${task.id}:deep-review:${review.runId ?? review.id ?? review.attempt}`,
    payload: {
      taskId: task.id,
      repo: task.repo,
      githubRepo: task.githubRepo,
      worktreeDir: task.worktreeDir,
      mission: task.mission,
      modelPolicy: task.modelPolicy,
      riskTier: "high",
      prompt,
      metadata: {
        runtimeOwner: "personal-dashboard.integration-worker",
        actionId: "deep-review-coding-task",
        taskId: task.id,
        reviewer: task.modelPolicy?.reviewer,
        readOnly: true
      }
    }
  });
}

export async function validateCodingAgentTasks(options = {}) {
  const tasksResponse =
    options.tasksResponse ??
    (await getDashboardJson("/api/apps/coding-agent/tasks?includeArchived=false"));
  const maxRepairAttempts =
    options.maxRepairAttempts ?? envNumber("CODING_AGENT_MAX_REPAIR_ATTEMPTS", 3);
  const tasks = (tasksResponse.tasks ?? []).filter((task) => {
    if (task.status !== "running") {
      return false;
    }
    if (!validationCommandsForTask(task).length) {
      return false;
    }
    const runId = task.latestHermesRunId ?? task.hermesRunId;
    return !task.latestValidation || task.latestValidation.runId !== runId;
  });
  const results = [];
  for (const task of tasks) {
    const validation = await runCodingTaskValidation(task, options);
    const persisted = await (
      options.persistValidation ??
      ((payload) => postDashboardAction("/api/apps/coding-agent/validate", payload))
    )({
      ...validation,
      maxRepairAttempts
    });
    const repair =
      validation.status === "failed"
        ? await (options.dispatchRepair ?? dispatchCodingTaskValidationRepair)(task, validation, {
            maxRepairAttempts
          })
        : { dispatched: false, reason: "validation_passed" };
    results.push({
      taskId: task.id,
      status: validation.status,
      attempt: validation.attempt,
      persisted,
      repair
    });
  }
  return { taskCount: tasks.length, results };
}

export async function reviewCodingAgentTasks(options = {}) {
  const tasksResponse =
    options.tasksResponse ??
    (await getDashboardJson("/api/apps/coding-agent/tasks?includeArchived=false"));
  const maxRepairAttempts =
    options.maxRepairAttempts ?? envNumber("CODING_AGENT_MAX_REPAIR_ATTEMPTS", 3);
  const tasks = (tasksResponse.tasks ?? []).filter((task) => {
    if (
      !["running", "pr-open", "changes-requested"].includes(task.status) ||
      task.latestValidation?.status !== "passed"
    ) {
      return false;
    }
    const runId = task.latestHermesRunId ?? task.hermesRunId;
    return (
      task.reviewRequest?.status === "pending" ||
      !task.latestReview ||
      task.latestReview.runId !== runId
    );
  });
  const results = [];
  for (const task of tasks) {
    const review = await runCodingTaskReview(task, options);
    const persisted = await (
      options.persistReview ??
      ((payload) => postDashboardAction("/api/apps/coding-agent/review", payload))
    )({ ...review, reviewRequestId: task.reviewRequest?.id, maxRepairAttempts });
    const repair =
      review.status === "blocked"
        ? await (options.dispatchRepair ?? dispatchCodingTaskReviewRepair)(task, review, {
            maxRepairAttempts
          })
        : {
            dispatched: false,
            reason: review.status === "clean" ? "review_clean" : "review_not_repairable"
          };
    const deepReview = await (options.dispatchDeepReview ?? dispatchCodingTaskDeepReview)(
      task,
      review,
      { maxRepairAttempts }
    );
    results.push({
      taskId: task.id,
      status: review.status,
      attempt: review.attempt,
      persisted,
      repair,
      deepReview
    });
  }
  return { taskCount: tasks.length, results };
}

async function syncTaskPrSnapshot(task, snapshot) {
  return postDashboardAction("/api/apps/coding-agent/pr-status", {
    taskId: task.id,
    repo: task.repo,
    githubRepo: snapshot.repo,
    prNumber: snapshot.prNumber,
    prState: snapshot.prState,
    branch: snapshot.branch,
    prUrl: snapshot.prUrl,
    reviewState: snapshot.reviewState,
    checks: snapshot.checks,
    githubCursor: snapshot.cursor,
    latestPrEvents: snapshot.actionable
  });
}

export async function pollCodingAgentPrs(options = {}) {
  const tasksResponse =
    options.tasksResponse ??
    (await getDashboardJson("/api/apps/coding-agent/tasks?includeArchived=false"));
  const tasks = (tasksResponse.tasks ?? []).filter((task) =>
    ["pr-open", "changes-requested", "waiting-for-approval"].includes(task.status)
  );
  const results = [];
  for (const task of tasks) {
    const snapshot = await fetchCodingTaskPrSnapshot(task, options);
    if (snapshot.skipped) {
      results.push({ taskId: task.id, skipped: true, reason: snapshot.reason });
      continue;
    }
    const feedback = dedupePrFeedbackAgainstInternalReview(snapshot.actionable, task.latestReview);
    const dispatchSnapshot = { ...snapshot, actionable: feedback.actionable };
    const sync = await (options.syncTaskPrSnapshot ?? syncTaskPrSnapshot)(task, snapshot);
    const dispatch = dispatchSnapshot.actionable.length
      ? await (options.dispatchCodingTaskUpdate ?? dispatchCodingTaskUpdate)(task, dispatchSnapshot)
      : { dispatched: false, reason: "no_actionable_pr_events" };
    results.push({
      taskId: task.id,
      repo: snapshot.repo,
      prNumber: snapshot.prNumber,
      events: snapshot.events.length,
      actionable: snapshot.actionable.length,
      deduplicated: feedback.deduplicated.length,
      synced: true,
      sync,
      dispatch
    });
  }
  return { taskCount: tasks.length, results };
}

export async function runConfiguredIngestions(options = {}) {
  const results = [];
  if (process.env.ASIA_TRAVEL_DEALS_API_BASE_URL) {
    results.push(await runIngestion("asia-travel-deals", pollAsiaTravelDeals));
  }
  for (const feed of [
    { source: "hotel-rate-finder", envName: "HOTEL_RATE_FINDER_EVENTS_FILE" },
    {
      source: "flight-searcher",
      envName: "FLIGHTS_EXTENSION_EVENTS_FILE",
      fallbackEnvNames: ["FLIGHT_SEARCHER_EVENTS_FILE"]
    },
    { source: "plaid", envName: "PLAID_EVENTS_FILE" },
    { source: "gmail-intake", envName: "GMAIL_INTAKE_EVENTS_FILE" }
  ]) {
    results.push(await runIngestion(feed.source, () => ingestJsonFeed(feed)));
  }
  if (process.env.PLAID_SYNC_ENABLED === "true") {
    results.push(
      await runIngestion("plaid", () => postDashboardAction("/api/integrations/plaid/sync"))
    );
  }
  if (process.env.HOTEL_RATE_SYNC_ENABLED === "true") {
    results.push(
      await runIngestion("hotel-rate-finder", () =>
        postDashboardAction("/api/integrations/hotel-rate-finder/sync")
      )
    );
  }
  if (process.env.CODING_AGENT_PR_POLL_ENABLED === "true") {
    results.push(await runIngestion("coding-agent", pollCodingAgentPrs));
  }
  if (process.env.CODING_AGENT_PR_PICKUP_ENABLED === "true") {
    results.push(await runIngestion("coding-agent-pr-pickup", discoverCodingAgentPrPickups));
  }
  if (process.env.CODING_AGENT_ISSUE_TRIAGE_ENABLED === "true") {
    results.push(await runIngestion("coding-agent-issue-triage", discoverCodingAgentIssueTriage));
  }
  if (process.env.CODING_AGENT_VALIDATION_ENABLED === "true") {
    results.push(await runIngestion("coding-agent-validation", validateCodingAgentTasks));
  }
  if (process.env.CODING_AGENT_REVIEW_ENABLED === "true") {
    results.push(await runIngestion("coding-agent-review", reviewCodingAgentTasks));
  }
  if (
    process.env.CODING_AGENT_RECONCILE_ENABLED === "true" &&
    (options.startup || envBoolean("CODING_AGENT_RECONCILE_WATCHDOG_ENABLED", true))
  ) {
    results.push(
      await runIngestion("coding-agent-reconcile", () =>
        postDashboardAction("/api/apps/coding-agent/reconcile", {
          staleRunningMinutes: envNumber("CODING_AGENT_STALE_RUNNING_MINUTES", 90),
          runQuietMinutes: envNumber("CODING_AGENT_RUN_QUIET_MINUTES", 10)
        })
      )
    );
  }
  return results;
}

async function main() {
  const once = process.argv.includes("--once");
  const intervalSeconds = envNumber("ASIA_TRAVEL_DEALS_POLL_INTERVAL_SECONDS", 300);
  let startup = true;

  do {
    const results = await runConfiguredIngestions({ startup });
    startup = false;
    for (const result of results) {
      console.log(JSON.stringify(result));
    }
    if (!once) {
      await sleep(intervalSeconds * 1000);
    }
  } while (!once);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
