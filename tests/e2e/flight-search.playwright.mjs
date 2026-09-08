import { expect, test } from "@playwright/test";
import { createWebServer } from "../../apps/web/server.mjs";

test("award filters, result sorting and challenge input survive refresh", async ({ page }) => {
  const server = createWebServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let job = null;
  let submitted;
  const otpBrowserActions = [];
  await page.route("**/api/integrations/flight-searcher/**", async (route) => {
    const request = route.request();
    if (request.url().includes("/screenshot")) {
      return route.fulfill({ status: 404, body: "" });
    }
    if (request.url().endsWith("/browser-actions")) {
      otpBrowserActions.push(request.postDataJSON());
      return route.fulfill({ json: {} });
    }
    if (request.url().endsWith("/providers")) {
      return route.fulfill({
        json: [
          {
            id: "seats_aero",
            name: "Seats.aero",
            configured: true,
            programs: [
              { id: "aeroplan", name: "Air Canada Aeroplan" },
              { id: "united", name: "United MileagePlus" }
            ]
          },
          {
            id: "ana",
            name: "ANA Mileage Club",
            configured: true,
            scope: "International ANA and eligible Star Alliance awards."
          }
        ]
      });
    }
    if (request.method() === "POST") {
      submitted = request.postDataJSON();
      job = {
        id: "search_test",
        status: "waiting_human",
        request: submitted,
        providers: {
          ana: {
            state: "waiting_human",
            challenge: {
              id: "otp",
              provider: "ana",
              status: "pending",
              kind: "email_otp",
              prompt: "Enter your code",
              responseFormat: "text",
              screenshotAvailable: true,
              expiresAt: "2026-12-01T12:00:00Z"
            }
          }
        },
        results: [
          {
            id: "a",
            origin: "NRT",
            destination: "TPE",
            departureDate: "2026-11-01",
            availabilityStatus: "available",
            mileage: 70000,
            stops: 0,
            cabin: "business",
            program: "aeroplan",
            provider: "seats_aero",
            bookingUrl: "https://seats.aero/search/a",
            flightNumbers: ["NH107"],
            carriers: ["ANA"],
            taxes: 52.4,
            taxCurrency: "USD",
            departsAt: "2026-11-01T17:00:00Z",
            arrivesAt: "2026-11-02T02:00:00Z",
            aircraftCode: "789",
            segments: [
              {
                origin: "NRT",
                destination: "TPE",
                flightNumber: "NH107",
                operatingCarrier: "ANA",
                aircraftCode: "789",
                aircraftName: "Boeing 787-9",
                cabin: "business",
                departureLocalTime: "17:00",
                arrivalLocalTime: "20:00"
              }
            ]
          },
          {
            id: "b",
            origin: "NRT",
            destination: "TPE",
            departureDate: "2026-11-02",
            mileage: 50000,
            stops: 0,
            cabin: "business",
            program: "united",
            provider: "seats_aero"
          },
          {
            id: "waitlist",
            origin: "NRT",
            destination: "TPE",
            departureDate: "2026-10-31",
            availabilityStatus: "waitlist",
            mileage: 10000,
            stops: 0,
            cabin: "business",
            program: "eva infinity mileage lands",
            provider: "eva"
          }
        ]
      };
      return route.fulfill({ status: 202, json: job });
    }
    return route.fulfill({ json: job ? [job] : [] });
  });
  try {
    await page.goto(`${base}/flights`);
    await page.locator('[data-token-field="origins"] [data-token-entry]').fill("Tokyo");
    await page.locator('[data-token-field="origins"] [data-token-entry]').press("Enter");
    await page.getByRole("button", { name: "Remove TYO" }).click();
    await page.locator('[data-token-field="origins"] [data-token-entry]').fill("NRT");
    await page.locator('[data-token-field="origins"] [data-token-entry]').press("Enter");
    await page.locator('[data-token-field="destinations"] [data-token-entry]').fill("TPE");
    await page.locator('[data-token-field="destinations"] [data-token-entry]').press("Enter");
    await page.locator('[data-token-field="programs"] [data-token-entry]').fill("Aeroplan");
    await page.locator('[data-token-field="programs"] [data-token-entry]').press("Enter");
    const initialDeparture = await page.locator('[name="departureStart"]').inputValue();
    const initialDate = new Date(`${initialDeparture}T00:00:00Z`);
    const lastDay = new Date(
      Date.UTC(initialDate.getUTCFullYear(), initialDate.getUTCMonth() + 1, 0)
    ).getUTCDate();
    const offset = initialDate.getUTCDate() <= lastDay - 2 ? 2 : -2;
    const otherDate = new Date(initialDate);
    otherDate.setUTCDate(initialDate.getUTCDate() + offset);
    const otherDeparture = otherDate.toISOString().slice(0, 10);
    const departureStart = offset > 0 ? initialDeparture : otherDeparture;
    const departureEnd = offset > 0 ? otherDeparture : initialDeparture;
    const departurePicker = page.locator('[data-date-range-picker="departure"]');
    await departurePicker.locator(".date-range-trigger").click();
    await departurePicker.locator(`[data-date="${departureStart}"]`).click();
    await departurePicker.locator(`[data-date="${departureEnd}"]`).click();
    await departurePicker.getByRole("button", { name: "Apply dates" }).click();
    await expect(page.locator('[name="departureStart"]')).toHaveValue(departureStart);
    await expect(page.locator('[name="departureEnd"]')).toHaveValue(departureEnd);

    const returnPicker = page.locator('[data-date-range-picker="return"]');
    await returnPicker.locator(".date-range-trigger").click();
    if (departureStart !== departureEnd) {
      await expect(returnPicker.locator(`[data-date="${departureStart}"]`)).toBeDisabled();
    }
    await returnPicker.locator(`[data-date="${departureEnd}"]`).click();
    await returnPicker.locator(`[data-date="${departureEnd}"]`).click();
    await returnPicker.getByRole("button", { name: "Apply dates" }).click();
    await page.locator('[name="maxStops"]').selectOption("0");
    await page.locator('[name="maxPoints"]').fill("75000");
    await page.locator('input[name="airlineCabin-ana"][value="first"]').check();
    await page.getByRole("button", { name: "Search availability" }).click();
    await expect(page.locator(".result-row")).toHaveCount(2);
    expect(submitted).toMatchObject({
      departureStart,
      departureEnd,
      returnStart: departureEnd,
      returnEnd: departureEnd,
      maxStops: 0,
      maxPoints: 75000,
      providers: ["seats_aero", "ana"],
      airlineCabins: { ana: "first" },
      seatsAeroSources: ["aeroplan"]
    });
    await page.getByRole("button", { name: /Sort by Points/ }).click();
    await expect(page.locator(".result-row").first()).toContainText("50,000 pts");
    await page.locator('[data-result-expand="a"]').click();
    await expect(page.locator(".result-detail-row")).toContainText("NH107");
    await expect(page.locator(".result-detail-row")).toContainText("Boeing 787-9");
    await expect(page.locator(".result-detail-row")).toContainText("NRT → TPE");
    await page.locator('[data-result-expand="a"]').click();
    await expect(page.locator(".result-detail-row")).toHaveCount(0);
    await expect(page.locator("#result-count")).toHaveText("2 available · 1 waitlist hidden");
    await expect(page.getByText("Waitlist · not bookable")).toHaveCount(0);
    await page.locator("#show-waitlist").check();
    await expect(page.locator(".result-row")).toHaveCount(3);
    await expect(page.locator(".result-row").last()).toContainText("10,000 pts");
    await expect(page.getByText("Waitlist · not bookable")).toBeVisible();
    await expect(page.locator("#result-count")).toHaveText("2 available · 1 waitlist");
    await page.locator("#result-program-filter").selectOption("united");
    await expect(page.locator(".result-row")).toHaveCount(1);
    await page.locator("#result-program-filter").selectOption("");
    await page.locator("#result-view").selectOption("grid");
    await expect(page.locator(".date-result-grid")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "business" })).toBeVisible();
    await page.locator("#result-view").selectOption("table");
    await expect(page.getByRole("columnheader", { name: "Route" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "https://seats.aero/search/a"
    );
    await page
      .locator(".result-row")
      .first()
      .evaluate((element) => {
        element.dataset.renderSentinel = "preserved";
      });
    await page
      .locator(".history-row")
      .first()
      .evaluate((element) => {
        element.dataset.renderSentinel = "preserved";
      });
    await page.locator("[data-challenge-value]").fill("123456");
    await expect(page.getByRole("button", { name: "Scroll down" })).toBeVisible();
    await page.getByRole("button", { name: "Scroll down" }).click();
    await expect.poll(() => otpBrowserActions).toEqual([{ kind: "scroll", deltaY: 650 }]);
    const refreshed = page.waitForResponse((r) => r.url().includes("/searches?limit="));
    await page.locator("#refresh-searches").click();
    await refreshed;
    await expect(page.locator("[data-challenge-value]")).toHaveValue("123456");
    await expect(page.locator(".result-row").first()).toHaveAttribute(
      "data-render-sentinel",
      "preserved"
    );
    await expect(page.locator(".history-row").first()).toHaveAttribute(
      "data-render-sentinel",
      "preserved"
    );

    await page.locator('[data-token-field="origins"] [data-token-entry]').fill("SEA");
    await page.locator('[data-token-field="origins"] [data-token-entry]').press("Enter");
    await page.locator('[data-token-field="destinations"] [data-token-entry]').fill("HND");
    await page.locator('[data-token-field="destinations"] [data-token-entry]').press("Enter");
    await page.locator('[name="maxStops"]').selectOption("");
    await page.locator('[name="maxPoints"]').fill("");
    await page.getByRole("button", { name: "Use as search" }).click();
    await expect(page.locator('[name="origins"]')).toHaveValue("NRT");
    await expect(page.locator('[name="destinations"]')).toHaveValue("TPE");
    await expect(page.locator('[name="departureStart"]')).toHaveValue(departureStart);
    await expect(page.locator('[name="departureEnd"]')).toHaveValue(departureEnd);
    await expect(page.locator('[name="returnStart"]')).toHaveValue(departureEnd);
    await expect(page.locator('[name="returnEnd"]')).toHaveValue(departureEnd);
    await expect(page.locator('[name="maxStops"]')).toHaveValue("0");
    await expect(page.locator('[name="maxPoints"]')).toHaveValue("75000");
    await expect(page.locator('[name="seatsAeroSources"]')).toHaveValue("aeroplan");
    await expect(page.locator('input[name="providers"][value="seats_aero"]')).toBeChecked();
    await expect(page.locator("#form-status")).toContainText("Recent search copied");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
  } finally {
    await page.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("queued airline search identifies and cancels its older blocker", async ({ page }) => {
  const server = createWebServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let canceledJobId = null;
  const older = {
    id: "search_older",
    status: "running",
    request: {
      origins: ["NRT"],
      destinations: ["JFK"],
      departureStart: "2027-08-20",
      providers: ["ana"]
    },
    providers: { ana: { state: "running", message: "ANA search is running." } },
    results: [],
    createdAt: "2026-09-08T01:00:00Z"
  };
  const queued = {
    id: "search_queued",
    status: "running",
    request: {
      origins: ["TYO"],
      destinations: ["SFO"],
      departureStart: "2027-08-21",
      providers: ["ana"]
    },
    providers: {
      ana: {
        state: "queued",
        message: "Waiting for the ANA browser profile; 1 search ahead.",
        queueReason: "provider_profile",
        queuePosition: 2,
        queuedAt: new Date(Date.now() - 65_000).toISOString()
      }
    },
    results: [],
    createdAt: "2026-09-08T01:01:00Z"
  };
  await page.route("**/api/integrations/flight-searcher/**", async (route) => {
    const request = route.request();
    const url = request.url();
    if (url.endsWith("/providers")) return route.fulfill({ json: [] });
    if (request.method() === "POST" && url.endsWith("/search_older/cancel")) {
      canceledJobId = "search_older";
      older.status = "canceled";
      older.providers.ana.state = "canceled";
      queued.providers.ana.queuePosition = 1;
      queued.providers.ana.blockedByJobId = null;
      queued.providers.ana.message = "Starting the ANA browser profile.";
      return route.fulfill({ json: older });
    }
    return route.fulfill({ json: [queued, older] });
  });
  try {
    await page.goto(`${base}/flights`);
    await expect(page.locator("#run-title")).toHaveText("TYO → SFO");
    await expect(page.getByText("Queue position 2")).toContainText("waiting 1m");
    const cancelAhead = page.getByRole("button", {
      name: "Cancel ANA search ahead: NRT → JFK"
    });
    await expect(cancelAhead).toBeVisible();
    await cancelAhead.click();
    await expect.poll(() => canceledJobId).toBe("search_older");
    await expect(page.getByText("Queue position 1")).toBeVisible();
    await expect(cancelAhead).toHaveCount(0);
  } finally {
    await page.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("browser handoff exposes safe recovery controls and inline errors", async ({ page }) => {
  const server = createWebServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browserActions = [];
  const challengeResponses = [];
  let screenshotRequests = 0;
  const job = {
    id: "search_handoff",
    status: "waiting_human",
    request: {
      origins: ["HND"],
      destinations: ["SFO"],
      departureStart: "2026-11-01",
      departureEnd: "2026-11-09",
      providers: ["ana", "jal"]
    },
    providers: {
      ana: {
        state: "failed",
        message: "ANA's current international award launch link was not recognized.",
        errorCode: "ana_award_launch_unrecognized",
        debugHtmlAvailable: true,
        debugHtmlCapturedAt: "2026-11-01T10:00:30Z"
      },
      jal: {
        state: "waiting_human",
        challenge: {
          id: "browser",
          provider: "jal",
          status: "pending",
          kind: "browser_handoff",
          prompt: "Correct the airline search only if needed, then continue.",
          responseFormat: "acknowledge",
          screenshotAvailable: true,
          expiresAt: "2026-12-01T12:00:00Z"
        }
      }
    },
    results: []
  };
  await page.route("**/api/integrations/flight-searcher/**", async (route) => {
    const request = route.request();
    const url = request.url();
    if (url.endsWith("/providers")) {
      return route.fulfill({ json: [] });
    }
    if (url.includes("/screenshot")) {
      screenshotRequests += 1;
      return route.fulfill({ status: 404, body: "" });
    }
    if (url.endsWith("/providers/ana/debug-html")) {
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Sanitized selector report</title>"
      });
    }
    if (url.endsWith("/browser-actions")) {
      const action = request.postDataJSON();
      browserActions.push(action);
      if (action.key === "Escape") {
        return route.fulfill({ status: 409, json: { message: "Synthetic action rejection" } });
      }
      return route.fulfill({ json: {} });
    }
    if (url.endsWith("/respond")) {
      challengeResponses.push(request.postDataJSON());
      job.providers.jal.challenge.status = "answered";
      return route.fulfill({ json: job });
    }
    return route.fulfill({ json: [job] });
  });
  try {
    await page.goto(`${base}/flights`);
    await expect(page.getByText("ana_award_launch_unrecognized")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Download sanitized selector report" })
    ).toHaveAttribute(
      "href",
      "/api/integrations/flight-searcher/searches/search_handoff/providers/ana/debug-html"
    );
    await expect(page.getByRole("button", { name: "I finished — continue search" })).toBeVisible();
    await expect(page.locator("[data-browser-text]")).toBeVisible();

    await page.locator("[data-browser-text]").fill("SFO");
    await page.getByRole("button", { name: "Replace field" }).click();
    await expect.poll(() => browserActions).toEqual([{ kind: "replace", text: "SFO" }]);
    await page.locator("[data-browser-text]").fill(" terminal");
    await page.getByRole("button", { name: "Append" }).click();
    await expect.poll(() => browserActions.at(-1)).toEqual({ kind: "type", text: " terminal" });
    await expect(page.getByRole("button", { name: "← Backspace" })).toHaveAttribute(
      "title",
      "Delete one character to the left"
    );
    await expect(page.getByRole("button", { name: "Delete →" })).toHaveAttribute(
      "title",
      "Delete one character to the right"
    );
    await page.getByRole("button", { name: "↓" }).click();
    await expect.poll(() => browserActions.at(-1)).toEqual({ kind: "key", key: "ArrowDown" });
    await page.getByRole("button", { name: "Escape" }).click();
    await expect(page.locator("[data-challenge-status]")).toHaveText("Synthetic action rejection");
    const screenshotsBeforeRefresh = screenshotRequests;
    await page.getByRole("button", { name: "Refresh preview" }).click();
    await expect.poll(() => screenshotRequests).toBeGreaterThan(screenshotsBeforeRefresh);
    expect(browserActions.some((action) => action.kind === "refresh")).toBe(false);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Reload airline page…" }).click();
    await expect.poll(() => browserActions.at(-1)).toEqual({ kind: "refresh" });

    await page.getByRole("button", { name: "I finished — continue search" }).click();
    await expect.poll(() => challengeResponses).toEqual([{ value: "continue" }]);
  } finally {
    await page.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("intervention tabs preserve drafts and the preview accepts direct typing", async ({
  page
}) => {
  const server = createWebServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browserActions = [];
  const expiresAt = "2027-12-01T12:00:00Z";
  const job = {
    id: "search_parallel_interventions",
    status: "waiting_human",
    request: {
      origins: ["TYO"],
      destinations: ["SFO"],
      departureStart: "2027-08-21",
      departureEnd: "2027-08-25",
      providers: ["ana", "jal", "eva"]
    },
    providers: {
      ana: {
        state: "waiting_human",
        challenge: {
          id: "ana-email",
          provider: "ana",
          status: "pending",
          kind: "email_otp",
          prompt: "Enter the ANA email code.",
          responseFormat: "text",
          screenshotAvailable: true,
          expiresAt
        }
      },
      jal: {
        state: "waiting_human",
        challenge: {
          id: "jal-sms",
          provider: "jal",
          status: "pending",
          kind: "sms_otp",
          prompt: "Enter the JAL SMS code.",
          responseFormat: "text",
          screenshotAvailable: true,
          expiresAt
        }
      },
      eva: {
        state: "waiting_human",
        challenge: {
          id: "eva-browser",
          provider: "eva",
          status: "pending",
          kind: "browser_handoff",
          prompt: "Correct the EVA search form.",
          responseFormat: "acknowledge",
          screenshotAvailable: true,
          expiresAt
        }
      }
    },
    results: []
  };
  await page.route("**/api/integrations/flight-searcher/**", async (route) => {
    const request = route.request();
    const url = request.url();
    if (url.endsWith("/providers")) return route.fulfill({ json: [] });
    if (url.includes("/screenshot")) {
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900"><rect width="1440" height="900" fill="#eef2f7"/><rect x="120" y="100" width="400" height="80" fill="#fff" stroke="#222"/></svg>'
      });
    }
    if (url.endsWith("/browser-actions")) {
      browserActions.push(request.postDataJSON());
      return route.fulfill({ json: {} });
    }
    return route.fulfill({ json: [job] });
  });
  try {
    await page.goto(`${base}/flights`);
    const anaTab = page.getByRole("tab", { name: "ANA email code" });
    const jalTab = page.getByRole("tab", { name: "JAL SMS code" });
    const evaTab = page.getByRole("tab", { name: "EVA stuck page" });
    await expect(page.getByText("3 providers need you")).toBeVisible();
    await expect(anaTab).toHaveAttribute("aria-selected", "true");
    await page.locator("[data-challenge-value]:visible").fill("111111");

    await jalTab.click();
    await expect(jalTab).toHaveAttribute("aria-selected", "true");
    await page.locator("[data-challenge-value]:visible").fill("222222");
    await anaTab.click();
    await expect(page.locator("[data-challenge-value]:visible")).toHaveValue("111111");
    await anaTab.press("ArrowRight");
    await expect(jalTab).toBeFocused();
    await expect(page.locator("[data-challenge-value]:visible")).toHaveValue("222222");

    await evaTab.click();
    const preview = page.locator(".browser-shot:visible");
    await preview.click({ position: { x: 180, y: 100 } });
    await expect(page.locator(".browser-focus-marker")).toBeVisible();
    await expect(page.locator("[data-browser-input-surface]")).toBeFocused();
    await expect(page.getByText("Field selected", { exact: false })).toBeVisible();
    await page.keyboard.type("SFO");
    await page.keyboard.press("Backspace");
    await expect
      .poll(() => browserActions.slice(-2))
      .toEqual([
        { kind: "type", text: "SFO" },
        { kind: "key", key: "Backspace" }
      ]);
    await expect(page.locator("[data-browser-focus]")).toContainText("Backspace sent");
    await page.locator("[data-browser-input-surface]").evaluate((surface) => {
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", "SEA");
      surface.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard })
      );
    });
    await page.keyboard.press("Enter");
    await expect
      .poll(() => browserActions.slice(-2))
      .toEqual([
        { kind: "type", text: "SEA" },
        { kind: "key", key: "Enter" }
      ]);

    const refreshed = page.waitForResponse((response) =>
      response.url().includes("/searches?limit=")
    );
    await page.locator("#refresh-searches").click();
    await refreshed;
    await expect(evaTab).toHaveAttribute("aria-selected", "true");
    await anaTab.click();
    await expect(page.locator("[data-challenge-value]:visible")).toHaveValue("111111");
  } finally {
    await page.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
