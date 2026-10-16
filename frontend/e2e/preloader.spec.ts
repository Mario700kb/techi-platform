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

test("moving to a page whose code is still on its way keeps the current page, with no loading bar", async ({
  page,
}) => {
  test.skip(test.info().project.name !== "desktop");
  // Held from the start: the background prefetch waits on it too.
  const release = await holdChunk(page, "Alerts");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  await page.getByRole("link", { name: "Alerts", exact: true }).first().click();
  await page.waitForTimeout(600);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.locator(".th-preloader--inline")).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Loading TECHI Connect" })).toHaveCount(0);

  release();
  await expect(page.getByRole("heading", { name: "Alerts" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toHaveCount(0);
});

test("once the first page shows, the other pages' code is fetched in the background", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop");
  const fetched = new Set<string>();
  page.on("request", (request) => {
    const name = new URL(request.url()).pathname.match(/^\/assets\/([A-Za-z]+)-/)?.[1];
    if (name) fetched.add(name);
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  await expect
    .poll(() => ["Devices", "Alerts", "Reports", "Operators", "ClientProfile"].filter((n) => !fetched.has(n)))
    .toEqual([]);
  expect(fetched.has("TerminalWindow")).toBe(false);
});

test("a reload of Reports opens at once while the feature flags are still loading", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop");
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports" }).first()).toBeVisible();

  let release = () => undefined as void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/platform/features", async (route) => {
    await released;
    await route.fallback();
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Reports" }).first()).toBeVisible();
  await expect(page.locator(".th-preloader--inline")).toHaveCount(0);
  release();
});
