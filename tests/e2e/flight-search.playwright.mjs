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
    await page.getByRole("button", { name: "Search availability" }).click();
    await expect(page.locator(".result-row")).toHaveCount(2);
    expect(submitted).toMatchObject({
      departureStart,
      departureEnd,
      returnStart: departureEnd,
      returnEnd: departureEnd,
      maxStops: 0,
      maxPoints: 75000,
      providers: ["seats_aero"]
    });
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
