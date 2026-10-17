import type { Page } from "@playwright/test";
import { metricsFixture, monitoringFixture } from "../src/components/__tests__/monitoringFixtures";
import { fakePowerShell, mockPowerShellSession, mockScripts } from "./fakePowerShell";
import { DEVICES } from "./mockApi";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

// NW-RECEPTION-01 on agent 2.1.29: Windows with the "powershell" capability.
const RECEPTION = { ...DEVICES[0], agent_version: "2.1.29", capabilities: { powershell: "1" } };

async function mockDevice(page: Page) {
  await page.route(
    (url) => url.pathname === "/api/v1/devices/",
    (route) => {
      const devices = DEVICES.map((d) => (d.id === 1 ? RECEPTION : d));
      return route.fulfill({ json: { devices, total: devices.length } });
    },
  );
  await page.route("**/api/v1/devices/1", (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: RECEPTION }) : route.fallback(),
  );
  await page.route("**/api/v1/devices/1/metrics?**", (route) => {
    const range = new URL(route.request().url()).searchParams.get("range") ?? "24h";
    return route.fulfill({ json: metricsFixture({ range: range as "24h" }) });
  });
  await page.route("**/api/v1/devices/1/monitoring", (route) => route.fulfill({ json: monitoringFixture(true) }));
}

async function openReception(page: Page) {
  await page.goto("/devices");
  await page.locator("tr", { hasText: "NW-RECEPTION-01" }).getByText("NW-RECEPTION-01").first().click();
}

test("Overview sums up the last 24 hours and opens Monitoring", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the drawer is the desktop device view");
  await mockDevice(page);
  await openReception(page);

  const card = page.getByRole("region", { name: "Last 24 hours" });
  await expect(card.getByText("1-minute data · nothing lost")).toBeVisible();
  await expect(card.getByText(/peak 71% at/)).toBeVisible();
  await expect(card.getByText(/peak 48%/)).toBeVisible();
  await expect(card.getByTestId("monitors-summary")).toHaveText("1 firing · CPU above 95% for 15 min");
  // The Live panel stays where it was: one value, one place.
  await expect(page.getByRole("region", { name: "Live" })).toBeVisible();
  await card.screenshot({ path: testInfo.outputPath("last-24h.png") });

  await card.getByRole("button", { name: /Open Monitoring/ }).click();
  await expect(page.getByRole("tab", { name: "Monitoring" })).toHaveAttribute("aria-selected", "true");
});

test("Monitoring tab renders charts, disks, coverage and monitors", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the drawer is the desktop device view");
  await mockDevice(page);
  await openReception(page);
  await page.getByRole("tab", { name: "Monitoring" }).click();

  const panel = page.getByTestId("device-monitoring");
  await expect(panel.getByTestId("metrics-source")).toHaveText("1-minute data from the agent · nothing lost");
  await expect(panel.getByRole("img", { name: "CPU usage over time" })).toBeVisible();
  await expect(panel.getByRole("img", { name: "Memory used over time" })).toBeVisible();
  await expect(panel.getByRole("img", { name: "Network receive and send over time" })).toBeVisible();
  await expect(panel.getByTestId("disk-row")).toHaveCount(2);
  await expect(panel.getByText("grows 1.1 GB/day · 90% in 9 days · full in 41 days")).toBeVisible();
  const coverage = panel.getByRole("region", { name: "Data coverage" });
  await expect(coverage.getByText("99.98%")).toBeVisible();
  await expect(coverage.getByTestId("coverage-bar").locator("[data-kind]")).toHaveCount(6);
  const monitors = panel.getByRole("region", { name: "Monitors" });
  await expect(monitors.getByText("Firing")).toBeVisible();
  await expect(monitors.getByText("above 95% for 15 min · critical")).toBeVisible();
  await expect(panel.getByTestId("delivery").getByText("4 samples")).toBeVisible();

  // Hovering a chart shows the values at that moment.
  await panel.getByRole("img", { name: "CPU usage over time" }).hover({ position: { x: 300, y: 60 } });
  await expect(panel.locator(".th-chart-tip")).toContainText("avg");

  const week = page.waitForRequest((r) => r.url().includes("/devices/1/metrics?range=7d"));
  await panel.getByRole("radio", { name: "7 days" }).click();
  await week;
  await panel.screenshot({ path: testInfo.outputPath("monitoring-tab.png") });
});

test("PowerShell opens only with a valid two-factor code", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the drawer is the desktop device view");
  await mockDevice(page);
  await page.route("**/api/v1/devices/1/terminal/sessions?**", (route) => route.fulfill({ json: [] }));
  await mockPowerShellSession(page, 1, "ps-1");
  await mockScripts(page);
  const shell = await fakePowerShell(page, "ps-1");

  await openReception(page);
  await page.getByRole("tab", { name: "Maintenance" }).click();
  const section = page.getByRole("region", { name: "PowerShell" });
  await expect(section.getByText("Console history")).toBeVisible();
  await section.getByRole("button", { name: /Open PowerShell/ }).click();

  const dialog = page.getByRole("dialog", { name: "Open PowerShell as administrator" });
  await dialog.getByLabel("Two-factor code").fill("000000");
  await dialog.getByRole("button", { name: "Open PowerShell" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Wrong or expired code. Enter the current code from your app.");

  await dialog.getByLabel("Two-factor code").fill("123456");
  await dialog.getByRole("button", { name: "Open PowerShell" }).click();
  await expect(dialog).toHaveCount(0);
  const consoleBox = section.getByTestId("powershell-console");
  await expect(consoleBox.locator(".ps-chip", { hasText: "Recording" })).toBeVisible();
  await expect(consoleBox.getByText(/idle closes in/)).toBeVisible();
  await expect(consoleBox.locator(".xterm")).toBeVisible();
  await expect(consoleBox.getByRole("heading", { name: "NW-RECEPTION-01 · PowerShell (Administrator)" })).toBeVisible();

  // Compact layout: console 360 px tall, then Session | Saved scripts side by side, then the command list.
  const screenBox = await consoleBox.locator(".ps-screen").boundingBox();
  expect(screenBox?.height).toBe(360);
  const session = await consoleBox
    .getByTestId("ps-session-details")
    .locator("xpath=ancestor::section[1]")
    .boundingBox();
  const scripts = await consoleBox.locator("section", { hasText: "Saved scripts" }).boundingBox();
  expect(Math.abs((session?.width ?? 0) - (scripts?.width ?? 1))).toBeLessThanOrEqual(1);
  expect(Math.abs((session?.y ?? 0) - (scripts?.y ?? 1))).toBeLessThanOrEqual(1);

  await consoleBox.getByRole("textbox", { name: "Command" }).fill("hostname");
  await consoleBox.getByRole("textbox", { name: "Command" }).press("Enter");
  await expect.poll(() => shell.received).toContain("hostname\r");
  await expect(consoleBox.getByRole("list", { name: "Commands this session" }).getByText("hostname")).toBeVisible();
  await expect(consoleBox.getByTestId("ps-command-count")).toHaveText("1 · 0 failed");
  const drawer = page.locator(".th-drawer-panel");
  expect(await drawer.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  // Tall enough to show the whole section (the drawer scrolls inside itself).
  await page.setViewportSize({ width: 1440, height: 1700 });
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: testInfo.outputPath("powershell-open.png") });

  await consoleBox.getByRole("button", { name: "End session" }).click();
  await expect(section.getByRole("button", { name: /Open PowerShell/ })).toBeVisible();
});

test("the drawer is wide enough for every tab on a laptop screen", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the drawer is the desktop device view");
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockDevice(page);
  await openReception(page);

  const panel = page.locator(".th-drawer-panel");
  await expect(page.getByRole("tab", { name: "Timeline" })).toBeVisible();
  const box = await panel.boundingBox();
  expect(box?.width).toBe(720);
  const last = await page.getByRole("tab", { name: "Timeline" }).boundingBox();
  expect((last?.x ?? 0) + (last?.width ?? 0)).toBeLessThanOrEqual((box?.x ?? 0) + (box?.width ?? 0));
  await panel.screenshot({ path: testInfo.outputPath("drawer-1440.png") });
});
