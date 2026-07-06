import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { codingAgentExecutorPayload } from "../packages/integrations/coding-agent.mjs";

const execFileAsync = promisify(execFile);

function envNumber(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
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

async function readJsonFeed(filePath) {
  const payload = JSON.parse(await readFile(filePath, "utf8"));
  return Array.isArray(payload) ? payload : [payload];
}

async function ingestJsonFeed({ source, envName }) {
  const filePath = process.env[envName];
  if (!filePath) {
    return { source, skipped: true, reason: `${envName} is not configured` };
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
    html_url: comment.html_url
  };
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
  const executorPayload = codingAgentExecutorPayload(task, {
    repo: snapshot.repo,
    prNumber: snapshot.prNumber,
    events: snapshot.actionable,
    checks: snapshot.checks,
    cursor: snapshot.cursor
  });
  return postDashboardAction("/api/hermes/actions", {
    capabilityId: "update-coding-task",
    origin: "dashboard",
    idempotencyKey: `coding-agent:${task.id}:${executorPayload.mode}:${snapshot.cursor.updatedAt}`,
    payload: executorPayload
  });
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
    const sync = await (options.syncTaskPrSnapshot ?? syncTaskPrSnapshot)(task, snapshot);
    const dispatch = await (options.dispatchCodingTaskUpdate ?? dispatchCodingTaskUpdate)(
      task,
      snapshot
    );
    results.push({
      taskId: task.id,
      repo: snapshot.repo,
      prNumber: snapshot.prNumber,
      events: snapshot.events.length,
      actionable: snapshot.actionable.length,
      synced: true,
      sync,
      dispatch
    });
  }
  return { taskCount: tasks.length, results };
}

export async function runConfiguredIngestions() {
  const results = [];
  if (process.env.ASIA_TRAVEL_DEALS_API_BASE_URL) {
    results.push(await runIngestion("asia-travel-deals", pollAsiaTravelDeals));
  }
  for (const feed of [
    { source: "hotel-rate-finder", envName: "HOTEL_RATE_FINDER_EVENTS_FILE" },
    { source: "flight-searcher", envName: "FLIGHT_SEARCHER_EVENTS_FILE" },
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
  return results;
}

async function main() {
  const once = process.argv.includes("--once");
  const intervalSeconds = envNumber("ASIA_TRAVEL_DEALS_POLL_INTERVAL_SECONDS", 300);

  do {
    const results = await runConfiguredIngestions();
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
