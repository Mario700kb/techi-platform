import { DEVICES } from "./mockApi";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

test.beforeEach(() => {
  test.skip(test.info().project.name !== "desktop", "the drawer is the desktop device view");
});

test("clicking an alert row opens that device's drawer", async ({ page }) => {
  await page.goto("/alerts");
  const row = page.locator("tr.th-alerts-row").first();
  const device = (await row.locator(".th-alerts-link").innerText()).trim();
  await row.locator("td").nth(2).click();
  await expect(page).toHaveURL(/\/devices/);
  const drawer = page.locator(".th-drawer-panel");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: device })).toBeVisible();
});

test("clicking an alert in the bell opens that device's drawer", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /alerts|notifications/i })
    .first()
    .click();
  const item = page
    .locator("[role=dialog], .th-notif-panel, .th-menu")
    .getByRole("button")
    .filter({ hasText: /NW-|BH-/ })
    .first();
  const text = await item.innerText();
  await item.click();
  await expect(page).toHaveURL(/\/devices/);
  const drawer = page.locator(".th-drawer-panel");
  await expect(drawer).toBeVisible();
  const host = text.match(/(NW-[A-Z0-9-]+|BH-[A-Z0-9-]+)/)![1];
  await expect(drawer.getByRole("heading", { name: host })).toBeVisible();
});

// Production has ~900 devices and 20–50 per page, so an alert's device is
// usually not on the table's current page; the drawer must still open.
test("an alert opens its device even when it is not on the table's current page", async ({ page }) => {
  await page.route("**/api/v1/devices/?*", (route) =>
    route.fulfill({ json: { devices: DEVICES.filter((d) => d.id === 1), total: DEVICES.length } }),
  );
  await page.goto("/alerts");
  const row = page.locator("tr.th-alerts-row", { hasText: "BH-WH-SCANNER" }).first();
  await row.locator("td").nth(2).click();

  const drawer = page.locator(".th-drawer-panel");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "BH-WH-SCANNER" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: /Connect/ }).first()).toBeVisible();
  // The table itself still shows only its own page.
  await expect(
    page.locator("tr", { hasText: "BH-WH-SCANNER" }).filter({ hasNot: page.locator(".th-drawer-panel") }),
  ).toHaveCount(0);
});
