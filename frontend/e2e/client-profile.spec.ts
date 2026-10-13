import type { Page } from "@playwright/test";

import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

// Northwind in production's shape: 42 devices over two categories and groups,
// alerts of three kinds, and an activity log of remote sessions and actions.
async function northwindProfile(page: Page) {
  await page.route("**/api/v1/clients/1/profile", (route) =>
    route.fulfill({
      json: {
        client: {
          id: 1,
          name: "Northwind Clinic",
          slug: "northwind",
          description: "Clinic network, 3 sites",
          is_active: true,
          created_at: "2025-02-01T00:00:00Z",
        },
        stats: { total: 42, online: 28, stale: 3, offline: 11 },
        by_category: {
          clientpc: { total: 32, online: 21, stale: 2, offline: 9 },
          servers: { total: 9, online: 7, stale: 1, offline: 1 },
          network: { total: 1, online: 0, stale: 0, offline: 1 },
        },
        alerts: {
          total_open: 14,
          by_severity: { critical: 5, warning: 9 },
          by_kind: { device_offline: 6, low_disk: 5, high_ram: 3 },
          devices_affected: 12,
          oldest_open_at: iso(60 * 50),
        },
        average_health: 74,
        health_critical: 3,
        health_warning: 8,
        needs_updates: 7,
        agents_outdated: 2,
        groups: [
          { id: 1, name: "Front desk", devices: 18 },
          { id: 3, name: "Labs", devices: 15 },
          { id: 4, name: "Servers", devices: 9 },
        ],
        last_seen: iso(1),
      },
    }),
  );
  await page.route("**/api/v1/clients/1/activity*", (route) =>
    route.fulfill({
      json: {
        total: 3,
        device_names: { "1": "NW-RECEPTION-01", "3": "NW-SRV-01" },
        items: [
          {
            id: 9,
            operator_id: 1,
            operator_username: "denis",
            action: "remote_connect",
            entity_type: "device",
            entity_id: 1,
            device_id: 1,
            client_id: 1,
            details_json: '{"ip": "10.0.0.5"}',
            created_at: iso(5),
          },
          {
            id: 8,
            operator_id: 2,
            operator_username: "sabina",
            action: "action_queued",
            entity_type: "remote_action",
            entity_id: 77,
            device_id: 3,
            client_id: 1,
            details_json: '{"action_type": "restart_device"}',
            created_at: iso(40),
          },
          {
            id: 7,
            operator_id: 1,
            operator_username: "denis",
            action: "terminal_session_closed",
            entity_type: "terminal_session",
            entity_id: null,
            device_id: 3,
            client_id: 1,
            details_json: '{"reason": "operator_closed"}',
            created_at: iso(180),
          },
        ],
      },
    }),
  );
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: a client's profile shows its figures, sections and tabs`, async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "checked at desktop width; the page stacks on phones");
    await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    await northwindProfile(page);
    await page.goto("/clients/1");

    await expect(page.getByRole("heading", { name: "Northwind Clinic" })).toBeVisible();
    for (const figure of ["42", "67%", "14", "74", "7"]) {
      await expect(page.locator(".th-onb-stat", { hasText: figure }).first()).toBeVisible();
    }
    await expect(page.getByRole("heading", { name: "Devices by category" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Open alerts by type" })).toBeVisible();
    await expect(page.getByText("NW-RECEPTION-01").first()).toBeVisible();
    // Four overview cards in two even columns.
    const cards = page.locator('[role="tabpanel"] section.premium-card');
    await expect(cards).toHaveCount(4);
    const boxes = await cards.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
    expect(Math.max(...boxes) - Math.min(...boxes)).toBeLessThan(2);
    await page.screenshot({ path: test.info().outputPath(`profile-overview-${theme}.png`), fullPage: true });

    await page.getByRole("tab", { name: /Devices/ }).click();
    await expect(page.locator("tbody tr").first()).toBeVisible();
    await page.getByRole("tab", { name: /Alerts/ }).click();
    await expect(page.getByRole("tab", { name: "Open" })).toBeVisible();
    await page.getByRole("tab", { name: /Activity/ }).click();
    await expect(page.getByText("NW-SRV-01").first()).toBeVisible();
    await page.getByRole("tab", { name: /Analytics/ }).click();
    await expect(page.getByRole("heading", { name: "Availability" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`profile-analytics-${theme}.png`), fullPage: true });
    await expect(page.getByRole("tab", { name: /Documentation/ })).toBeDisabled();
  });
}

test("a client row on the Clients page opens its profile", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop");
  await northwindProfile(page);
  await page.goto("/clients");
  await page.getByRole("link", { name: "Northwind Clinic" }).click();
  await expect(page).toHaveURL(/\/clients\/1$/);
  await expect(page.getByRole("heading", { name: "Northwind Clinic" })).toBeVisible();
});

test("an unknown client shows a clear message", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop");
  await page.route("**/api/v1/clients/99/**", (route) =>
    route.fulfill({ status: 404, json: { detail: "Client not found" } }),
  );
  await page.goto("/clients/99");
  await expect(page.getByText("Couldn't open this client")).toBeVisible();
});
