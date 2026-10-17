import type { Page } from "@playwright/test";
import { metricsFixture, monitoringFixture } from "../src/components/__tests__/monitoringFixtures";
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
  await page.route("**/api/v1/devices/1/terminal/sessions", (route) => {
    const body = route.request().postDataJSON() as { engine: string; mfa_code: string };
    expect(body.engine).toBe("powershell");
    if (body.mfa_code !== "123456") {
      return route.fulfill({
        status: 403,
        json: { detail: { code: "mfa_invalid", detail: "Enter a current two-factor code." } },
      });
    }
    const origin = new URL(page.url()).origin.replace(/^http/, "ws");
    return route.fulfill({
      json: {
        session_id: "ps-1",
        operator_ws_path: `${origin}/ws/terminal/ps-1?ticket=t`,
        operator_ticket: "t",
        expires_in_seconds: 60,
      },
    });
  });
  await page.routeWebSocket(/\/ws\/terminal\/ps-1/, (ws) => {
    ws.send("PS C:\\Windows\\system32> ");
  });

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
  await expect(consoleBox.getByText("Session open")).toBeVisible();
  await expect(consoleBox.getByText(/idle closes in/)).toBeVisible();
  await expect(consoleBox.locator(".xterm")).toBeVisible();
  await section.screenshot({ path: testInfo.outputPath("powershell-open.png") });

  await consoleBox.getByRole("button", { name: "End session" }).click();
  await expect(section.getByRole("button", { name: /Open PowerShell/ })).toBeVisible();
});
