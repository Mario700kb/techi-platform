import type { Page } from "@playwright/test";
import { northwindMonitoring, northwindProfile } from "./profileMocks";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

async function openAnalytics(page: Page) {
  await page.goto("/clients/1");
  await page.getByRole("tab", { name: /Analytics/ }).click();
  await expect(page.getByRole("heading", { name: "CPU by device and hour" })).toBeVisible();
}

/** No sideways scroll on the page itself. */
async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const main = document.querySelector(".th-main");
    const doc = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    return Math.max(doc, main ? main.scrollWidth - main.clientWidth : 0);
  });
  expect(overflow).toBeLessThan(2);
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: analytics shows the client's figures, heatmap, attention and devices`, async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "the phone layout has its own test");
    await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    await northwindProfile(page);
    await openAnalytics(page);

    // Five even figures.
    const stats = page.locator('[role="tabpanel"] .th-onb-stat');
    await expect(stats).toHaveCount(5);
    for (const [label, value] of [
      ["Devices reporting", "3 / 4"],
      ["Data coverage", "99.7%"],
      ["Monitor alerts", "3"],
      ["CPU across the client", "18%"],
      ["Disks at risk", "1"],
    ]) {
      await expect(stats.filter({ hasText: label })).toContainText(value);
    }
    await expect(stats.filter({ hasText: "CPU across the client" })).toContainText("Busiest hour 10:00 · 41%");
    const widths = await stats.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(2);
    await expect(page.getByText("2 of 4 devices on 1-minute data · hourly averages")).toBeVisible();

    // Heatmap: a row per device with 24 hours, busiest first.
    const heat = page.getByRole("region", { name: "CPU load by device and hour" });
    const rows = heat.locator(".th-ca-heat-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText("NW-SRV-01");
    await expect(rows.first()).toContainText("97%");
    await expect(rows.first().locator(".th-ca-heat-cell")).toHaveCount(24);
    await rows.nth(1).locator(".th-ca-heat-cell").nth(10).hover();
    await expect(heat.locator(".th-chart-tip")).toContainText("NW-RECEPTION-01 · 10:00");

    const attention = page.getByRole("region", { name: "Needs attention" });
    await expect(attention.locator(".th-ca-attn-item")).toHaveCount(3);
    await expect(attention).toContainText("NW-SRV-01 · D: fills up");
    await expect(attention).toContainText("NW-DOCTOR-02 · not seen for 4 days");

    const coverage = page.getByRole("region", { name: "Data coverage" });
    await expect(coverage).toContainText("Received late, from the device buffer");
    await expect(coverage).toContainText("Device-off time is not counted as missing.");

    const table = page.getByRole("region", { name: "Devices" }).locator("table");
    await expect(table.locator("tbody tr")).toHaveCount(3);
    const server = table.locator("tr", { hasText: "NW-SRV-01" });
    await expect(server).toContainText("1 firing");
    await expect(server).toContainText("D: 86%");
    await expect(table.locator("tr", { hasText: "NW-DOCTOR-02" })).toContainText("5-min only");

    // Symmetric: cards side by side share their top, height and footer line.
    for (const [left, right] of [
      ["CPU load by device and hour", "Needs attention"],
      ["Client trend", "Data coverage"],
    ]) {
      const a = (await page.getByRole("region", { name: left }).boundingBox())!;
      const b = (await page.getByRole("region", { name: right }).boundingBox())!;
      expect(Math.abs(a.y - b.y)).toBeLessThan(2);
      expect(Math.abs(a.height - b.height)).toBeLessThan(2);
    }
    const heatBox = (await heat.boundingBox())!;
    const trendBox = (await page.getByRole("region", { name: "Client trend" }).boundingBox())!;
    expect(Math.abs(heatBox.width - trendBox.width)).toBeLessThan(2);
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: test.info().outputPath(`client-analytics-${theme}.png`), fullPage: true });
  });
}

test("the range switch asks for that range and keeps it across tabs", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop");
  await northwindProfile(page);
  const requests: string[] = [];
  page.on("request", (r) => r.url().includes("/clients/1/monitoring") && requests.push(r.url()));
  await openAnalytics(page);
  expect(requests.some((u) => u.endsWith("range=7d"))).toBe(true);
  await expect(page.getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true");

  await page.getByRole("radio", { name: "30 days" }).click();
  await expect.poll(() => requests.some((u) => u.endsWith("range=30d"))).toBe(true);
  await expect(page.getByText("2 of 4 devices on 1-minute data · daily averages")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "CPU · 30 days" })).toBeVisible();

  await page.getByRole("tab", { name: /Overview/ }).click();
  await page.getByRole("tab", { name: /Analytics/ }).click();
  await expect(page.getByRole("radio", { name: "30 days" })).toHaveAttribute("aria-checked", "true");

  await page.getByRole("radio", { name: "24 h" }).click();
  await expect.poll(() => requests.some((u) => u.endsWith("range=24h"))).toBe(true);
});

test("a device on the analytics tab opens in the drawer in place", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "the drawer is the desktop device view");
  await northwindProfile(page);
  await openAnalytics(page);
  const drawer = page.locator(".th-drawer-panel");

  await page.getByRole("button", { name: /^Open NW-SRV-01, peak CPU/ }).click();
  await expect(page).toHaveURL(/\/clients\/1$/);
  await expect(drawer.getByRole("heading", { name: "NW-SRV-01" })).toBeVisible();
  await drawer.getByRole("button", { name: "Close" }).click();
  await expect(drawer).toBeHidden();

  await page.locator(".th-ca-attn-item", { hasText: "memory pressure" }).click();
  await expect(drawer.getByRole("heading", { name: "NW-RECEPTION-01" })).toBeVisible();
  await drawer.getByRole("button", { name: "Close" }).click();
  await expect(drawer).toBeHidden();

  await page.getByRole("row", { name: "Open NW-DOCTOR-02" }).click();
  await expect(drawer.getByRole("heading", { name: "NW-DOCTOR-02" })).toBeVisible();
});

test("before any device runs agent 2.1.29 the tab works from heartbeat data", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop");
  await northwindProfile(page);
  const base = northwindMonitoring();
  await page.route("**/api/v1/clients/1/monitoring?*", (route) =>
    route.fulfill({
      json: {
        ...base,
        one_minute_devices: 0,
        coverage_pct: null,
        coverage_breakdown: { received: 0, late: 0, missing_minutes: 0, off_minutes: 0, pct: null, segments: [] },
        devices: base.devices.map((d) => ({ ...d, one_minute: false, coverage_pct: null, monitors_firing: 0 })),
      },
    }),
  );
  await openAnalytics(page);
  await expect(page.getByRole("note")).toContainText(
    "1-minute data and coverage arrive as devices update to agent 2.1.29",
  );
  await expect(page.locator(".th-onb-stat", { hasText: "Data coverage" })).toContainText("Arrives with agent 2.1.29");
  await expect(page.getByRole("region", { name: "Data coverage" })).toContainText("No coverage yet");
  await expect(page.getByText("5-min only")).toHaveCount(3);
});

test("a failed load offers a retry", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop");
  await northwindProfile(page);
  let fail = true;
  await page.route("**/api/v1/clients/1/monitoring?*", (route) =>
    fail
      ? route.fulfill({ status: 500, json: { detail: "Analytics are unavailable" } })
      : route.fulfill({ json: northwindMonitoring() }),
  );
  await page.goto("/clients/1");
  await page.getByRole("tab", { name: /Analytics/ }).click();
  await expect(page.getByText("Couldn't load analytics")).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "CPU by device and hour" })).toBeVisible();
});

test("phones stack the analytics without sideways scrolling", async ({ page }) => {
  test.skip(test.info().project.name !== "mobile");
  await northwindProfile(page);
  await openAnalytics(page);
  await expect(page.locator(".th-ca-heat-row")).toHaveCount(3);
  // One column: the heatmap and attention cards stack.
  const heat = (await page.getByRole("region", { name: "CPU load by device and hour" }).boundingBox())!;
  const attention = (await page.getByRole("region", { name: "Needs attention" }).boundingBox())!;
  expect(attention.y).toBeGreaterThan(heat.y + heat.height - 2);
  expect(Math.abs(attention.width - heat.width)).toBeLessThan(2);
  // The device table turns into cards.
  await expect(page.getByRole("region", { name: "Devices" }).locator("thead")).toBeHidden();
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: test.info().outputPath("client-analytics-mobile.png"), fullPage: true });
});
