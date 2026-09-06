import { expect, test } from "@playwright/test";
import http from "node:http";

import { createWebServer } from "../../apps/web/server.mjs";
import { dashboardFixture } from "../../packages/fixtures/dashboard.mjs";
import { financeOverview } from "../../packages/finance/index.mjs";
import {
  aggregateTransactions,
  queryTransactions,
  transactionQueryFromSearchParams
} from "../../packages/transactions/index.mjs";

async function withDashboard(page, run, dashboard = dashboardFixture()) {
  await page.clock.setFixedTime(new Date("2026-09-06T12:00:00Z"));
  await page.route("https://cdn.plaid.com/**", (route) =>
    route.fulfill({ body: "", contentType: "text/javascript" })
  );
  const state = { failDashboard: false, failTransactions: false, mutations: [] };
  const api = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const query = transactionQueryFromSearchParams(url.searchParams);
    let payload;
    if (url.pathname === "/api/dashboard") {
      response.statusCode = state.failDashboard ? 503 : 200;
      payload = dashboard;
    } else if (url.pathname === "/api/integrations/plaid/connection-settings") {
      payload = { browserLinkEnabled: true, onboarding: "browser", tokenStorage: "local" };
    } else if (url.pathname === "/api/transactions") {
      response.statusCode = state.failTransactions ? 503 : 200;
      payload = queryTransactions(dashboard.transactions, query, dashboard.finance.accounts);
    } else if (url.pathname === "/api/transactions/aggregate") {
      payload = aggregateTransactions(
        dashboard.transactions,
        { ...query, groupBy: url.searchParams.get("groupBy") },
        dashboard.finance.accounts
      );
    } else if (url.pathname === "/api/finance/overview") {
      payload = financeOverview(
        { ...dashboard.finance, transactions: dashboard.transactions },
        query
      );
    } else if (request.method === "POST") {
      state.mutations.push({ path: url.pathname, authorization: request.headers.authorization });
      response.statusCode = 503;
      payload = { error: "missing_plaid_config" };
    } else {
      response.statusCode = 404;
      payload = {};
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const web = createWebServer({ proxyBaseUrl: `http://127.0.0.1:${api.address().port}` });
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await run(`http://127.0.0.1:${web.address().port}`, state);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    web.closeAllConnections();
    api.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => web.close(resolve)),
      new Promise((resolve) => api.close(resolve))
    ]);
  }
}

test("every home card opens its app and Finance contains only finance controls", async ({
  page
}) => {
  await withDashboard(page, async (base) => {
    for (const [card, heading, anchor] of [
      ["Hotel rates", "Travel", "rates"],
      ["Finance", "Finance"],
      ["Trips", "Travel", "trips"],
      ["Flight deals", "Travel", "deals"],
      ["Coding", "Coding"],
      ["Inbox", "Inbox"]
    ]) {
      await page.goto(base);
      await expect(page.getByRole("heading", { name: "Welcome home, Moo." })).toBeVisible();
      await expect(page.locator("#home-notice")).toContainText("Sample data");
      await page.locator(".porthole").filter({ hasText: card }).click();
      await expect(
        page.getByRole("heading", { name: heading, exact: true, level: 1 })
      ).toBeVisible();
      if (anchor) await expect(page.locator(`#${anchor}`)).toBeInViewport();
      if (card === "Coding") await expect(page.locator("#tasks .task")).toHaveCount(3);
      if (card === "Inbox") await expect(page.locator("#intake .compact-card")).toHaveCount(2);
      if (card === "Finance") {
        await expect(page.locator("#transactions")).toContainText("Momoshop");
        await expect(page.locator("#bridge-console")).toHaveCount(0);
        await expect(page.locator("#travel-watches")).toHaveCount(0);
      }
    }
    await page.getByRole("link", { name: "Connections", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Connected apps" })).toBeVisible();
  });
});

test("finance filters, sorting, empty results and reset work together", async ({ page }) => {
  await withDashboard(page, async (base) => {
    await page.goto(`${base}/finance`);
    await expect(page.locator("#transaction-page")).toHaveText("1–5 of 5");
    await page.getByLabel("Sort by").selectOption("amount:desc");
    await expect(page.locator(".table-row").nth(1)).toContainText("$812.12");
    await page.getByLabel("Search", { exact: true }).fill("no such merchant");
    await expect(page.getByText("No transactions found", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Reset filters" }).click();
    await expect(page.locator("#transaction-page")).toHaveText("1–5 of 5");
    await expect(page.getByLabel("Search", { exact: true })).toBeEmpty();
    await expect(page.getByLabel("Sort by")).toHaveValue("date:desc");
    await page.getByRole("button", { name: "Bank accounts", exact: true }).click();
    await expect(page.getByText("No transactions found", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Credit cards", exact: true }).click();
    await expect(page.locator("#transaction-page")).toHaveText("1–5 of 5");
    await page.getByText("More filters", { exact: true }).click();
    await page.getByLabel("From", { exact: true }).fill("2026-06-01");
    await page.getByLabel("To", { exact: true }).fill("2026-01-01");
    await expect(page.locator("#transaction-error")).toContainText("Choose an end date");
    await page.getByRole("button", { name: "Reset filters" }).click();
    await expect(page.locator("#transaction-error")).toBeHidden();
  });
});

test("finance pagination reaches transactions beyond the first 75", async ({ page }) => {
  const dashboard = dashboardFixture();
  dashboard.transactions = Array.from({ length: 82 }, (_, index) => ({
    ...dashboard.transactions[0],
    id: `txn_${index}`,
    merchant: `Shop ${String(index).padStart(3, "0")}`,
    date: "2026-09-06"
  }));
  await withDashboard(
    page,
    async (base) => {
      await page.goto(`${base}/finance`);
      await expect(page.locator("#transaction-page")).toHaveText("1–75 of 82");
      await page.getByLabel("Sort by").selectOption("merchant:asc");
      await expect(page.locator(".table-row").nth(1)).toContainText("Shop 000");
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(page.locator("#transaction-page")).toHaveText("76–82 of 82");
      await expect(page.locator("#transactions")).toContainText("Shop 081");
      await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "Previous", exact: true }).click();
      await expect(page.locator("#transaction-page")).toHaveText("1–75 of 82");
    },
    dashboard
  );
});

test("load failures show recovery actions instead of empty financial totals", async ({ page }) => {
  await withDashboard(page, async (base, state) => {
    state.failDashboard = true;
    await page.goto(base);
    await page.getByRole("button", { name: "Try again" }).waitFor();
    state.failDashboard = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator(".porthole")).toHaveCount(7);
    state.failTransactions = true;
    await page.goto(`${base}/finance`);
    await expect(page.locator("#transaction-error")).toBeVisible();
    await expect(page.locator("#metrics .metric")).toHaveCount(0);
    state.failTransactions = false;
    await page.getByRole("button", { name: "Reset filters" }).click();
    await expect(page.locator("#transaction-page")).toHaveText("1–5 of 5");
    await expect(page.locator("#transaction-error")).toBeHidden();
  });
});

test("bank actions use session authentication and explain missing configuration", async ({
  page
}) => {
  await withDashboard(page, async (base, state) => {
    await page.goto(`${base}/finance`);
    await expect(page.getByRole("button", { name: "Refresh transactions" })).toBeDisabled();
    await page.getByText("API access", { exact: true }).click();
    await page.getByLabel("Dashboard access token").fill("test-session-token");
    await page.getByRole("button", { name: "Connect a bank" }).click();
    await expect(page.locator("#plaid-status")).toContainText(
      "Bank connections aren’t configured yet"
    );
    expect(state.mutations).toEqual([
      { path: "/api/integrations/plaid/link-token", authorization: "Bearer test-session-token" }
    ]);
    await page.reload();
    await expect(page.getByLabel("Dashboard access token")).toHaveValue("test-session-token");
  });
});

test("desktop and mobile keep amounts and account details readable without page overflow", async ({
  page
}) => {
  await withDashboard(page, async (base) => {
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}/finance`);
      const row = page.locator(".table-row").filter({ hasText: "Momoshop" });
      await expect(row).toBeVisible();
      await expect(row.getByText("Amex Gold • 1001", { exact: true })).toBeVisible();
      const amount = row.getByText("$126.40", { exact: true });
      await expect(amount).toBeVisible();
      const box = await amount.boundingBox();
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      await page.goto(base);
      await expect(page.locator(".porthole")).toHaveCount(7);
      expect(
        await page
          .locator(".item-row")
          .evaluateAll((rows) =>
            rows.every(
              (row) =>
                row.getBoundingClientRect().right <=
                row.closest(".porthole").getBoundingClientRect().right - 20
            )
          )
      ).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
    }
  });
});

test("connecting a bank exchanges the Link token and refreshes the finance view", async ({
  page
}) => {
  const dashboard = dashboardFixture();
  const calls = [];
  await page.addInitScript(() => {
    window.Plaid = {
      create(options) {
        return {
          open() {
            options.onSuccess("public-test-token", { institution: { name: "Test bank" } });
          }
        };
      }
    };
  });
  await page.route("**/api/integrations/plaid/*", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("connection-settings")) return route.fallback();
    calls.push({ path, body: request.postDataJSON() });
    let payload = {};
    if (path.endsWith("link-token")) payload = { linkToken: "link-test-token" };
    if (path.endsWith("sync")) {
      dashboard.finance.sync = { state: "synced", lastSync: "2026-09-06T12:00:00Z" };
      for (const item of dashboard.transactions) item.source = "plaid";
      payload = { synced: true, itemCount: 1 };
    }
    await route.fulfill({ json: payload });
  });
  await withDashboard(
    page,
    async (base) => {
      await page.goto(`${base}/finance`);
      await expect(page.locator("#transactions")).toContainText("Momoshop");
      await page.getByRole("button", { name: "Connect a bank" }).click();
      await expect(page.locator("#status-strip")).toHaveText("Accounts connected");
      await expect(page.getByRole("button", { name: "Refresh transactions" })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Connect a bank" })).toBeEnabled();
      expect(calls.map((call) => call.path)).toEqual([
        "/api/integrations/plaid/link-token",
        "/api/integrations/plaid/exchange-public-token",
        "/api/integrations/plaid/sync"
      ]);
      expect(calls[1].body).toEqual({
        publicToken: "public-test-token",
        institutionName: "Test bank"
      });
    },
    dashboard
  );
});

test("benefit setup stays out of the way until requested and preserves its save contract", async ({
  page
}) => {
  let saved;
  await page.route("**/api/finance/benefits", async (route) => {
    saved = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true } });
  });
  await withDashboard(page, async (base) => {
    await page.goto(`${base}/finance`);
    await expect(page.locator("#benefit-account option")).toHaveCount(4);
    await expect(page.locator("#benefit-name")).toBeHidden();
    await page.getByText("Add a benefit", { exact: true }).click();
    await page.locator("#benefit-name").fill("Airline credit");
    await page.locator("#benefit-account").selectOption("acct_001");
    await page.locator("#benefit-amount").fill("200");
    await page.locator("#benefit-patterns").fill("airline fee reimbursement");
    await page.getByRole("button", { name: "Save benefit" }).click();
    await expect(page.locator("#benefit-status")).toContainText("Saved");
    expect(saved).toEqual({
      name: "Airline credit",
      accountId: "acct_001",
      amount: 200,
      currency: "USD",
      period: "annual",
      periodStartMonth: 1,
      descriptorPatterns: "airline fee reimbursement"
    });
  });
});

test("1Password connections use owner setup and preserve sync error guidance", async ({ page }) => {
  const dashboard = dashboardFixture();
  dashboard.finance.plaidItems = [{ id: "item_test", syncStatus: "linked" }];
  await page.route("**/api/integrations/plaid/connection-settings", (route) =>
    route.fulfill({
      json: { tokenStorage: "onepassword", browserLinkEnabled: false, onboarding: "owner-tool" }
    })
  );
  await page.route("**/api/integrations/plaid/sync", (route) =>
    route.fulfill({
      status: 207,
      json: {
        synced: false,
        results: [
          {
            synced: false,
            reason: "plaid_token_migration_required",
            message: "This bank connection needs credential migration before it can sync."
          }
        ]
      }
    })
  );
  await withDashboard(
    page,
    async (base, state) => {
      await page.goto(`${base}/finance`);
      await page.getByRole("button", { name: "Connect a bank" }).click();
      await expect(
        page.getByRole("heading", { name: "Connect a bank with owner setup" })
      ).toBeVisible();
      expect(state.mutations).toHaveLength(0);
      await page.getByRole("button", { name: "Refresh transactions" }).click();
      await expect(page.locator("#plaid-status")).toContainText("needs credential migration");
      await expect(page.getByRole("button", { name: "Refresh transactions" })).toBeEnabled();
    },
    dashboard
  );
});
