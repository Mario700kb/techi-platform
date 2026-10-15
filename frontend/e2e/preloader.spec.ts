import type { Page } from "@playwright/test";

import { expect, test } from "./test";

// Hold a lazily loaded page's code until released, as a slow network would.
async function holdChunk(page: Page, name: string) {
  let release = () => undefined as void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(new RegExp(`/assets/${name}-.*\\.js$`), async (route) => {
    await released;
    await route.continue();
  });
  return release;
}

test("a reload keeps the full-screen preloader until the page's code arrives", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop");
  await page.goto("/devices");
  await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();

  const release = await holdChunk(page, "Devices");
  await page.reload();
  // The boot screen's preloader stays: no empty shell with a bar.
  await expect(page.getByRole("status", { name: "Loading TECHI Connect" })).toBeVisible();
  await expect(page.locator(".th-preloader--inline")).toHaveCount(0);
  release();
  await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading TECHI Connect" })).toHaveCount(0);
});

test("moving between pages shows the in-page bar, not the full screen", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  const release = await holdChunk(page, "Alerts");
  await page.getByRole("link", { name: "Alerts", exact: true }).first().click();
  await expect(page.locator(".th-preloader--inline")).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading TECHI Connect" })).toHaveCount(0);
  release();
  await expect(page.getByRole("heading", { name: "Alerts" })).toBeVisible();
});
