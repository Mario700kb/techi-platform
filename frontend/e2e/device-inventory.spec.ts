import type { Page } from "@playwright/test";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

async function openSoftwareTab(page: Page, hostname: string) {
  await page.goto("/devices");
  await page.locator("tr", { hasText: hostname }).getByText(hostname).first().click();
  await page.getByRole("tab", { name: /Software/ }).click();
  await page.getByRole("button", { name: "Load inventory" }).click();
}

test("the inventory tab summarises patches and shows one list at a time", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "the drawer is the desktop device view");
  await openSoftwareTab(page, "NW-DOCTOR-02");

  const summary = page.getByLabel("Patch status", { exact: true });
  await expect(summary.getByText("Updates available")).toBeVisible();
  await expect(summary.getByText("Waiting to install")).toBeVisible();
  await expect(summary.getByText("Not required")).toBeVisible();

  const lists = page.getByRole("radiogroup", { name: "Inventory list" });
  await expect(lists.getByRole("radio", { name: /Software\s*12/ })).toHaveAttribute("aria-checked", "true");
  // Alphabetical, publisher under the name.
  const firstRow = page.locator(".th-inv-table tbody tr").first();
  await expect(firstRow).toContainText("7-Zip 24.08 (x64)");
  await expect(firstRow).toContainText("Igor Pavlov");

  await page.getByRole("textbox", { name: "Search software" }).fill("microsoft");
  await expect(page.getByText("4 of 12 apps")).toBeVisible();
  await page.getByRole("textbox", { name: "Search software" }).fill("nothing-like-this");
  await expect(page.getByText("No matches")).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).first().click();
  await expect(page.locator(".th-inv-table tbody tr")).toHaveCount(12);

  // No services reported: an empty state, not an empty table.
  await lists.getByRole("radio", { name: /Services/ }).click();
  await expect(lists.getByRole("radio", { name: /Services/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("No services reported")).toBeVisible();
  await expect(page.locator(".th-inv-table")).toHaveCount(0);

  // Processes, heaviest first.
  await lists.getByRole("radio", { name: /Processes/ }).click();
  await expect(page.locator(".th-inv-table tbody tr").first()).toContainText("OUTLOOK.EXE");
  await expect(page.locator(".th-inv-table tbody tr").first()).toContainText("1.5 GB");
});

test("services show their state and a pending reboot is flagged", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "the drawer is the desktop device view");
  await openSoftwareTab(page, "NW-RECEPTION-01");

  const summary = page.getByLabel("Patch status", { exact: true });
  await expect(summary.getByText("Reboot required")).toBeVisible();
  await expect(summary.getByText("Required", { exact: true })).toBeVisible();

  await page.getByRole("radio", { name: /Services\s*4/ }).click();
  const rows = page.locator(".th-inv-table tbody tr");
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText("Background Intelligent Transfer Service");
  await expect(rows.first()).toContainText("Start pending");
});

// SCREENS=1 npx playwright test device-inventory --project=desktop
for (const theme of ["dark", "light"] as const) {
  test(`screenshot ${theme}`, async ({ page }) => {
    test.skip(!process.env.SCREENS || test.info().project.name !== "desktop", "set SCREENS=1 to capture");
    await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    await openSoftwareTab(page, "NW-DOCTOR-02");
    await expect(page.getByLabel("Patch status", { exact: true })).toBeVisible();
    await page.screenshot({ path: `e2e/.screens/inventory-${theme}-software.png` });
    await page.getByRole("radio", { name: /Services/ }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `e2e/.screens/inventory-${theme}-services-empty.png` });
    await page.getByRole("radio", { name: /Processes/ }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `e2e/.screens/inventory-${theme}-processes.png` });
  });
}
