import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

const NAMES = [
  "Arta K",
  "Besi Ops",
  "Blerim D",
  "Dorina M",
  "Elton S",
  "Fatjon H",
  "Gerta L",
  "Ilir P",
  "Jona R",
  "Klevis T",
];

// Production's shape on 2026-10-13: eleven operators, five alert types, three
// device categories — the case where the old one-column operator list left
// the two cards beside it half empty.
async function productionShape(page: Page) {
  await page.route("**/api/v1/operators/presence", (route) =>
    route.fulfill({
      json: [
        { id: 1, username: "owner", display_name: "Owner", role: "owner", is_online: true, last_active_at: null },
        ...NAMES.map((name, i) => ({
          id: i + 2,
          username: name.toLowerCase().replace(" ", "."),
          display_name: name,
          role: i < 2 ? "admin" : "operator",
          is_online: i < 2,
          last_active_at: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
        })),
      ],
    }),
  );
  await page.route("**/api/v1/alerts/count*", (route) =>
    route.fulfill({
      json: {
        total_open: 193,
        by_severity: { warning: 100, critical: 93 },
        by_kind: { high_cpu: 2, high_ram: 10, low_disk: 90, device_offline: 88, rustdesk_sync_failure: 3 },
        devices_affected: 191,
      },
    }),
  );
  await page.route("**/api/v1/devices/overview", (route) =>
    route.fulfill({
      json: {
        stats: { total: 920, online: 683, stale: 20, offline: 217 },
        tree_counts: {
          total: 920,
          unassigned: 0,
          by_client: { "1": 920 },
          by_category: {
            servers: { total: 134, online: 120, stale: 2, offline: 12 },
            clientpc: { total: 783, online: 560, stale: 18, offline: 205 },
            network: { total: 3, online: 3, stale: 0, offline: 0 },
          },
        },
        critical: 4,
        warnings: 10,
        average_health: 88,
        needs_updates: 12,
        agents_outdated: 30,
        active_agent_version: "2.1.20",
        active_agent_sha256: null,
        loaded_at: new Date().toISOString(),
      },
    }),
  );
}

/** Space between a card's last row and the end of its content area. */
async function emptyBelowRows(card: Locator): Promise<number> {
  return card.evaluate((section) => {
    const rows = section.querySelectorAll("li");
    const last = rows[rows.length - 1].getBoundingClientRect();
    const foot = section.querySelector(".th-panel-foot");
    const end = foot ? foot.getBoundingClientRect().top : section.getBoundingClientRect().bottom;
    return end - last.bottom;
  });
}

for (const width of [1280, 1440, 1920]) {
  test(`operators, alerts by type and devices by category fill their row at ${width}px`, async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "the three cards are on the desktop dashboard");
    await productionShape(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");

    const operators = page.locator("section[aria-labelledby='operators-title']");
    const alerts = page.locator("section[aria-labelledby='alerts-by-kind-title']");
    const devices = page.locator("section[aria-labelledby='devices-by-category-title']");
    await expect(operators.getByText("Klevis T")).toBeVisible();
    await expect(alerts.getByRole("listitem")).toHaveCount(5);
    await expect(devices.getByRole("listitem")).toHaveCount(3);
    await expect(devices.getByRole("listitem").first()).toContainText("560 online");

    // Operators sit two to a row, so eleven of them take six rows, not eleven.
    const tops = await operators
      .getByRole("listitem")
      .evaluateAll((items) => new Set(items.map((item) => Math.round(item.getBoundingClientRect().top))).size);
    expect(tops).toBe(6);

    const heights = await Promise.all(
      [operators, alerts, devices].map(async (card) => (await card.boundingBox())!.height),
    );
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
    expect(heights[0]).toBeLessThan(420);

    for (const card of [operators, alerts, devices]) {
      expect(await emptyBelowRows(card)).toBeLessThan(32);
    }
  });
}
