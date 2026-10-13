import type { Locator, Page } from "@playwright/test";

import { DEVICES } from "./mockApi";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

// The worst case seen in production: one row carrying Reboot, Maintenance and
// Duplicate at once. In the old single-line, overflow-hidden badge row the
// second and third tags were cut off by the cell.
async function crowdedRow(page: Page) {
  const crowded = {
    ...DEVICES[0],
    is_in_maintenance: true,
    duplicate_candidate: true,
    duplicate_of_device_id: 5,
    duplicate_score: 0.92,
  };
  await page.route("**/api/v1/devices/?*", (route) =>
    route.fulfill({ json: { devices: [crowded, ...DEVICES.slice(1)], total: DEVICES.length } }),
  );
  await page.route("**/api/v1/devices/table-details*", (route) =>
    route.fulfill({
      json: {
        health: [],
        patches: [{ device_id: crowded.id, reboot_required: true, pending_updates: 0, patch_state: "reboot_required" }],
      },
    }),
  );
}

async function expectInside(tag: Locator, box: Locator) {
  const t = (await tag.boundingBox())!;
  const b = (await box.boundingBox())!;
  expect(t.x).toBeGreaterThanOrEqual(b.x - 0.5);
  expect(t.x + t.width).toBeLessThanOrEqual(b.x + b.width + 0.5);
  expect(t.height).toBeLessThanOrEqual(18);
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: crowded device row shows every tag whole`, async ({ page }) => {
    await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    await crowdedRow(page);
    await page.goto("/devices");

    const desktop = test.info().project.name === "desktop";
    const container = desktop
      ? page.locator("tbody tr").first().locator("td").nth(1)
      : page.locator(".th-mdev-list > *").first();
    // The mobile card has never carried a Duplicate tag.
    const labels = desktop ? ["Reboot", "Maintenance", "Duplicate"] : ["Reboot", "Maintenance"];
    for (const label of labels) {
      const tag = container.locator(".th-tag", { hasText: label });
      await expect(tag).toBeVisible();
      await expectInside(tag, container);
      expect(await tag.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await page.screenshot({ path: test.info().outputPath(`tags-${theme}.png`) });
  });
}
