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

/** The largest gap between two consecutive meter rows in a card. */
async function largestGapBetweenRows(card: Locator): Promise<number> {
  return card.evaluate((section) => {
    const rows = [...section.querySelectorAll(".th-cp-meter")].map((row) => row.getBoundingClientRect());
    return rows.slice(1).reduce((gap, row, i) => Math.max(gap, row.top - rows[i].bottom), 0);
  });
}

for (const width of [1280, 1440, 1920]) {
  test(`operators, alerts by type and devices by category share one row at ${width}px`, async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "the three cards are on the desktop dashboard");
    await productionShape(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");

    const operators = page.locator("section[aria-labelledby='operators-title']");
    const alerts = page.locator("section[aria-labelledby='alerts-by-kind-title']");
    const devices = page.locator("section[aria-labelledby='devices-by-category-title']");
    await expect(operators.getByText("Klevis T")).toBeVisible();
    await expect(alerts.locator(".th-cp-meter")).toHaveCount(5);
    await expect(devices.locator(".th-cp-meter")).toHaveCount(3);
    await expect(devices.locator(".th-cp-meter").first()).toHaveAttribute("title", /560 online/);
    // Each card leads with a ring and its legend: alerts by severity, devices by
    // category (Fleet health already splits the fleet by status).
    await expect(alerts.locator(".th-cp-legend")).toContainText("Critical");
    await expect(devices.locator(".th-cp-ring")).toContainText("920");
    await expect(devices.locator(".th-cp-legend")).toContainText("Client PCs");

    // Operators sit two to a row, so eleven of them take six rows, not eleven.
    const tops = await operators
      .getByRole("listitem")
      .evaluateAll((items) => new Set(items.map((item) => Math.round(item.getBoundingClientRect().top))).size);
    expect(tops).toBe(6);

    const boxes = await Promise.all([operators, alerts, devices].map(async (card) => (await card.boundingBox())!));
    const heights = boxes.map((box) => box.height);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
    expect(heights[0]).toBeLessThan(450);

    // Rows sit together under their heading, never spread apart to fill the
    // card (the gap the owner saw with two categories beside a taller card).
    for (const card of [alerts, devices]) {
      expect(await largestGapBetweenRows(card)).toBeLessThan(6);
    }
    await page.screenshot({ path: test.info().outputPath(`dashboard-row-${width}.png`) });
  });
}
