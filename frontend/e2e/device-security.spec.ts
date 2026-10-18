import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

test("the overview shows the security posture once the inventory is loaded", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "the drawer is the desktop device view");
  await page.goto("/devices");
  await page.locator("tr", { hasText: "NW-RECEPTION-01" }).getByText("NW-RECEPTION-01").first().click();

  // The device runs 2.1.20: the card says what it needs and loads nothing.
  await expect(page.getByText(/Needs agent 2\.1\.31/)).toBeVisible();

  await page.getByRole("tab", { name: /Software/ }).click();
  await page.getByRole("button", { name: "Load inventory" }).click();
  await expect(page.getByLabel("Patch status", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /Overview/ }).click();

  const grid = page.getByLabel("Security posture");
  await expect(grid).toBeVisible();
  await expect(grid.getByText("Defender", { exact: true })).toBeVisible();
  await expect(grid.getByText("Off: Public")).toBeVisible();
  await expect(grid.getByText("BitLocker C:")).toBeVisible();
  await expect(grid.locator('[title*="Domain Admins"]')).toContainText("2");
  await expect(page.getByText(/^Collected 1h ago$/)).toBeVisible();
});
