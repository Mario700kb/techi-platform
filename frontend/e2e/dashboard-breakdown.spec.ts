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
  test(`right-now and composition rows keep their cards level at ${width}px`, async ({ page }) => {
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

    // "Right now" (needs attention, alerts by type) and "Fleet composition" (by
    // client, by category, operators). Cards in a row share one height and top.
    const attention = page.locator("section[aria-labelledby='attention-title']");
    const clients = page.locator("section[aria-labelledby='devices-by-client-title']");
    for (const row of [
      [attention, alerts],
      [clients, devices, operators],
    ]) {
      const boxes = await Promise.all(row.map(async (card) => (await card.boundingBox())!));
      const heights = boxes.map((box) => box.height);
      const tops = boxes.map((box) => box.y);
      expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
      expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1);
      expect(heights[0]).toBeLessThan(480);
    }

    // Rows sit together under their heading, never spread apart to fill the
    // card (the gap the owner saw with two categories beside a taller card).
    for (const card of [alerts, devices]) {
      expect(await largestGapBetweenRows(card)).toBeLessThan(6);
    }
    await page.screenshot({ path: test.info().outputPath(`dashboard-row-${width}.png`) });
  });
}

// Eight clients, so "2 more clients" appears the way it does in production.
async function manyClients(page: Page) {
  const counts = [212, 180, 140, 118, 96, 74, 60, 40];
  const status = (count: number) => {
    const offline = Math.round(count * 0.25);
    return { total: count, online: count - offline, stale: 0, offline };
  };
  await page.route("**/api/v1/devices/overview", (route) =>
    route.fulfill({
      json: {
        stats: { total: 920, online: 683, stale: 20, offline: 217 },
        tree_counts: {
          total: 920,
          unassigned: 0,
          by_client: Object.fromEntries(counts.map((count, i) => [i + 1, count])),
          by_client_status: Object.fromEntries(counts.map((count, i) => [i + 1, status(count)])),
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
        active_agent_version: "2.1.47",
        active_agent_sha256: null,
        loaded_at: new Date().toISOString(),
      },
    }),
  );
}

// The widths where these drifted: laptop screens, with the sidebar closed and open.
for (const { width, sidebarOpen } of [
  { width: 1280, sidebarOpen: false },
  { width: 1366, sidebarOpen: false },
  { width: 1440, sidebarOpen: false },
  { width: 1440, sidebarOpen: true },
  { width: 1920, sidebarOpen: false },
]) {
  test(`everything lines up at ${width}px, sidebar ${sidebarOpen ? "open" : "closed"}`, async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "these rows are on the desktop dashboard");
    await productionShape(page);
    await manyClients(page);
    await page.addInitScript((open) => localStorage.setItem("techi.sidebar.collapsed", String(!open)), sidebarOpen);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    await expect(page.locator("section[aria-labelledby='system-status-title'] .th-status-row").first()).toBeVisible();
    await expect(page.locator("section[aria-labelledby='agent-versions-title'] .th-cp-meter").first()).toBeVisible();
    await expect(page.locator(".th-briefing-item")).toHaveCount(5);

    const m = await page.evaluate(() => {
      const box = (el: Element) => el.getBoundingClientRect();
      const textLeft = (el: Element) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getBoundingClientRect().left;
      };
      const cards = [...document.querySelectorAll(".th-dash section.premium-card")];
      const inset = (selector: string) =>
        cards
          .filter((card) => card.querySelector(selector))
          .map((card) => Math.round(textLeft(card.querySelector(selector)!) - box(card).left));
      const clipped = (selector: string) =>
        [...document.querySelectorAll(selector)]
          .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
          .map((el) => el.textContent);
      return {
        pillLines: new Set([...document.querySelectorAll(".th-briefing-item")].map((el) => Math.round(box(el).top)))
          .size,
        headHeights: [
          ...new Set([...document.querySelectorAll(".th-dash .th-panel-head")].map((el) => Math.round(box(el).height))),
        ],
        radii: [...new Set(cards.map((card) => getComputedStyle(card).borderRadius))],
        titleInsets: [...new Set(inset(".th-panel-head h2"))],
        subheadInsets: [...new Set(inset(".th-cp-subhead"))],
        headerHeights: [
          ...new Set(
            [...document.querySelectorAll(".th-dash .th-select, .th-dash .th-status-chip.\\!h-8")].map((el) =>
              Math.round(box(el).height),
            ),
          ),
        ],
        kpiHeights: [
          ...new Set([...document.querySelectorAll(".th-dash-kpi")].map((el) => Math.round(box(el).height))),
        ],
        kpiHintHeights: [
          ...new Set(
            [...document.querySelectorAll(".th-dash-kpi .th-kpi-hint")].map((el) => Math.round(box(el).height)),
          ),
        ],
        clippedLabels: clipped(".th-cp-meter-name > .truncate"),
        clippedCaptions: clipped(".th-dscore-caption"),
      };
    });

    expect(m.pillLines, "the five briefing pills sit on one line").toBe(1);
    expect(m.headHeights, "every card header is the same height").toHaveLength(1);
    expect(m.radii, "every card has the same corners").toEqual(["14px"]);
    expect(m.titleInsets, "every card title starts at the same inset").toHaveLength(1);
    expect(m.subheadInsets, "subheads start where the card titles do").toEqual(m.titleInsets);
    expect(m.headerHeights, "header controls are the same height").toEqual([32]);
    expect(m.kpiHintHeights, "no KPI hint wraps").toHaveLength(1);
    expect(m.kpiHeights).toHaveLength(1);
    expect(m.clippedLabels, "no meter label is cut off").toEqual([]);
    expect(m.clippedCaptions, "no scorecard caption is cut off").toEqual([]);

    // The other clients' bar shows their real status, like every client above it.
    const others = page.locator(".th-client-row", { hasText: "2 more clients" });
    await expect(others).toHaveAttribute("title", /75 online · 0 stale · 25 offline/);
    await expect(others).toContainText("75% online");
  });
}

test("between 1024 and 1279px no row is left half empty", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "these rows are on the desktop dashboard");
  await productionShape(page);
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.goto("/");
  await expect(page.locator("section[aria-labelledby='operators-title']").getByText("Klevis T")).toBeVisible();

  const rightEdges = await page.evaluate(() => {
    const right = (el: Element) => Math.round(el.getBoundingClientRect().right);
    const scores = [...document.querySelectorAll(".th-dscore")];
    return {
      dash: right(document.querySelector(".th-dash-hero")!),
      lastScore: right(scores[scores.length - 1]),
      operators: right(document.querySelector("section[aria-labelledby='operators-title']")!),
    };
  });
  expect(rightEdges.lastScore).toBe(rightEdges.dash);
  expect(rightEdges.operators).toBe(rightEdges.dash);
});
