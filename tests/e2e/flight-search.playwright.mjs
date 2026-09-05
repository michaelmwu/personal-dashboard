import { expect, test } from "@playwright/test";
import { createWebServer } from "../../apps/web/server.mjs";

test("award filters, result sorting and challenge input survive refresh", async ({ page }) => {
  const server = createWebServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let job = null;
  let submitted;
  await page.route("**/api/integrations/flight-searcher/**", async (route) => {
    const request = route.request();
    if (request.url().endsWith("/providers")) {
      return route.fulfill({ json: [{ id: "seats_aero", name: "Seats.aero", configured: true }] });
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
            mileage: 70000,
            stops: 0,
            cabin: "business",
            program: "aeroplan"
          },
          {
            id: "b",
            origin: "NRT",
            destination: "TPE",
            departureDate: "2026-11-02",
            mileage: 50000,
            stops: 0,
            cabin: "business",
            program: "united"
          }
        ]
      };
      return route.fulfill({ status: 202, json: job });
    }
    return route.fulfill({ json: job ? [job] : [] });
  });
  try {
    await page.goto(`${base}/flights`);
    await page.locator('[name="origins"]').fill("NRT");
    await page.locator('[name="destinations"]').fill("TPE");
    await page.locator('[name="maxStops"]').selectOption("0");
    await page.locator('[name="maxPoints"]').fill("75000");
    await page.getByRole("button", { name: "Search availability" }).click();
    await expect(page.locator(".result-row")).toHaveCount(2);
    expect(submitted).toMatchObject({ maxStops: 0, maxPoints: 75000, providers: ["seats_aero"] });
    await page.locator("#result-sort").selectOption("points");
    await expect(page.locator(".result-row").first()).toContainText("50,000 pts");
    await page.locator("[data-challenge-value]").fill("123456");
    const refreshed = page.waitForResponse((r) => r.url().includes("/searches?limit="));
    await page.locator("#refresh-searches").click();
    await refreshed;
    await expect(page.locator("[data-challenge-value]")).toHaveValue("123456");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
  } finally {
    await page.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
