import { expect, test } from "@playwright/test";
import { createPlaidOnboardingServer } from "../../scripts/lib/plaid-onboarding.mjs";

test("owner Link page saves through the separate provisioner and retries failed vault writes", async ({
  page
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const token = "access-owner-test-never-in-browser";
  let exchanges = 0;
  const saves = [];
  const { server, nonce } = createPlaidOnboardingServer({
    link: async () => ({ created: true, linkToken: "link-test" }),
    exchange: async () => {
      exchanges++;
      return { exchanged: true, itemId: "item_test", accessToken: token };
    },
    provision: async (value) => {
      saves.push(value);
      if (saves.length === 1) throw new Error("writer temporarily unavailable");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  await page.route("https://cdn.plaid.com/**", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.Plaid={create(options){return {open(){options.onSuccess('public-test',{institution:{name:'Test bank'}});options.onExit();}};}};`
    })
  );
  try {
    await page.goto(`${base}#${nonce}`);
    await expect(page).toHaveURL(base);
    await page.getByRole("button", { name: "Connect a bank", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retry saving connection" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect a bank", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Retry saving connection" }).click();
    await expect(page.getByRole("status")).toContainText("Bank connected");
    expect(exchanges).toBe(1);
    expect(saves).toHaveLength(2);
    expect(saves[1]).toMatchObject({
      accessToken: token,
      itemId: "item_test",
      institutionName: "Test bank"
    });
    expect(await page.content()).not.toContain(token);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
