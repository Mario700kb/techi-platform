import { expect, test } from "./test";

const PAGES = [
  { path: "/", heading: /dashboard|fleet/i },
  { path: "/devices", heading: /devices/i },
  { path: "/alerts", heading: /alerts/i },
  { path: "/operators", heading: /operators/i },
  { path: "/teams", heading: /teams/i },
  { path: "/audit", heading: /audit/i },
  { path: "/settings", heading: /settings/i },
  { path: "/notifications", heading: /notification/i },
];

for (const { path, heading } of PAGES) {
  test(`${path} renders without crashing`, async ({ page }) => {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
    await expect(page.getByText("Something went wrong on this page")).toHaveCount(0);
  });
}

test("devices list shows the fleet", async ({ page }) => {
  await page.goto("/devices");
  // Desktop table and phone cards are both in the DOM; check the one on screen.
  await expect(page.getByText("NW-RECEPTION-01").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText("BH-WH-SCANNER").filter({ visible: true }).first()).toBeVisible();
});

test("an unknown address shows the 404 page", async ({ page }) => {
  await page.goto("/remote-support");
  await expect(page.getByText("Page not found")).toBeVisible();
  await page.getByRole("button", { name: "Go to Dashboard" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test.describe("read-only operator", () => {
  test("is told when a page is not theirs to open", async ({ page, api }) => {
    api.user = (await import("./mockApi")).READONLY;
    await page.goto("/operators");
    await expect(page.getByText("You do not have access to this page")).toBeVisible();
  });
});

test("a reload keeps Reports in the sidebar while the feature flags load", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "the sidebar is the desktop navigation");
  await page.goto("/");
  const reports = page.getByRole("navigation").getByRole("link", { name: "Reports" });
  await expect(reports).toBeVisible();

  // The flags answer slowly on the reload; the menu must not lose Reports meanwhile.
  await page.route("**/api/v1/platform/features", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await route.fallback();
  });
  await page.reload();
  await expect(reports).toBeVisible({ timeout: 1000 });
});
