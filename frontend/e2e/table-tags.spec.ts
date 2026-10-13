import type { Locator, Page } from "@playwright/test";

import { DEVICES } from "./mockApi";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

// Production's worst cases on 2026-10-13: a row carrying maintenance, a
// pending reboot, a Remote Support conflict and a duplicate at once, in a
// group named after the device type; a device with a display name over its
// hostname; and a Remote Desktop sign-in among console ones.
async function productionRows(page: Page) {
  const crowded = {
    ...DEVICES[0],
    group_name: "Client PC",
    is_in_maintenance: true,
    duplicate_candidate: true,
    duplicate_of_device_id: 5,
    duplicate_score: 0.92,
    rustdesk_status: "conflicting_dual_install",
    user_source: "console",
  };
  const aliased = { ...DEVICES[2], display_name: "Clinic file server" };
  const rdp = { ...DEVICES[4], user_source: "rdp_session" };
  await page.route("**/api/v1/devices/?*", (route) =>
    route.fulfill({
      json: { devices: [crowded, DEVICES[1], aliased, DEVICES[3], rdp], total: DEVICES.length },
    }),
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

async function expectInside(tag: Locator, box: Locator, maxHeight: number) {
  const t = (await tag.boundingBox())!;
  const b = (await box.boundingBox())!;
  expect(t.x).toBeGreaterThanOrEqual(b.x - 0.5);
  expect(t.x + t.width).toBeLessThanOrEqual(b.x + b.width + 0.5);
  expect(t.height).toBeLessThanOrEqual(maxHeight);
  expect(await tag.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: device rows are one height, tags whole and folded past two`, async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "the table is desktop only");
    await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    await productionRows(page);
    await page.goto("/devices");

    const rows = page.locator("tbody tr.th-device-row");
    await expect(rows).toHaveCount(5);
    const heights = await rows.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
    expect(new Set(heights).size, `row heights ${heights.join(", ")}`).toBe(1);

    const cell = rows.first().locator("td.th-device-cell");
    const tags = cell.locator(".th-tag");
    await expect(tags).toHaveText(["Maintenance", "Reboot", "+2"]);
    await expect(tags.last()).toHaveAttribute("title", /Remote Support: Conflicting dual install\nPossible duplicate/);
    for (const tag of await tags.all()) await expectInside(tag, cell, 16);
    // The group already reads "Client PC", so the type is not repeated.
    await expect(cell).not.toContainText("Client PC");

    await expect(rows.nth(2).locator("td.th-device-cell")).toContainText("Clinic file serverNW-SRV-01");
    await expect(page.locator("tbody .th-tag", { hasText: /^Console$/ })).toHaveCount(0);
    await expect(rows.nth(4).locator(".th-tag", { hasText: "RDP" })).toBeVisible();

    await page.screenshot({ path: test.info().outputPath(`rows-${theme}.png`) });
  });

  test(`${theme}: mobile card tags stay whole`, async ({ page }) => {
    test.skip(test.info().project.name !== "mobile", "cards are the phone layout");
    await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    await productionRows(page);
    await page.goto("/devices");

    const card = page.locator(".th-mdev-list > *").first();
    // The mobile card has never carried a Duplicate tag.
    for (const label of ["Reboot", "Maintenance"]) {
      const tag = card.locator(".th-tag", { hasText: label });
      await expect(tag).toBeVisible();
      await expectInside(tag, card, 18);
    }
    await page.screenshot({ path: test.info().outputPath(`cards-${theme}.png`) });
  });
}
