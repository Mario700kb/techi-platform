import type { Page } from "@playwright/test";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

const FRAME = {
  cpu_percent: 37.5,
  ram_percent: 82.4,
  ram_used_mb: 13184,
  ram_total_mb: 16000,
  disks: [
    { mount: "C:", used_percent: 71, free_gb: 68.4, total_gb: 237.9 },
    { mount: "D:", used_percent: 93.2, free_gb: 31.6, total_gb: 465.8 },
  ],
  net_rx_kbps: 2480.4,
  net_tx_kbps: 95.1,
  uptime_seconds: 3 * 86400 + 5 * 3600,
  current_user: "NORTHWIND\\dr.hoxha",
  user_session_state: "active",
  process_count: 212,
  processes: [
    { pid: 4321, name: "sqlservr.exe", cpu_percent: 22.4, memory_mb: 4100 },
    { pid: 812, name: "chrome.exe", cpu_percent: 8.1, memory_mb: 690 },
    { pid: 9120, name: "OUTLOOK.EXE", cpu_percent: 2.3, memory_mb: 1530 },
    { pid: 640, name: "MsMpEng.exe", cpu_percent: 1.2, memory_mb: 310 },
    { pid: 2004, name: "explorer.exe", cpu_percent: 0.4, memory_mb: 140 },
  ],
};

async function liveSocket(page: Page, agentConnected = true) {
  const opened: string[] = [];
  await page.routeWebSocket(/\/ws\/devices\/\d+\/live/, (ws) => {
    opened.push(ws.url());
    ws.send(JSON.stringify({ type: "live_status", agent_connected: agentConnected, interval_seconds: 3 }));
    if (agentConnected) {
      setTimeout(() => ws.send(JSON.stringify({ type: "live", device_id: 2, data: FRAME })), 200);
    }
  });
  return opened;
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: the drawer streams the device live while Overview is open`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the drawer is the desktop device view");
    await page.addInitScript((v) => window.localStorage.setItem("techi.theme", v), theme);
    const opened = await liveSocket(page);
    await page.goto("/devices");
    await page.locator("tr", { hasText: "NW-DOCTOR-02" }).getByText("NW-DOCTOR-02").first().click();

    const panel = page.getByRole("region", { name: "Live" });
    await expect(panel.getByText("Live · every 3 s")).toBeVisible();
    await expect(panel.getByText("38%")).toBeVisible();
    await expect(panel.getByText("82%")).toBeVisible();
    await expect(panel.getByText("↓ 2.5 Mb/s")).toBeVisible();
    await expect(panel.getByText("dr.hoxha")).toBeVisible();
    await expect(panel.getByText("31.6 GB free of 466 GB")).toBeVisible();
    await expect(panel.getByText("sqlservr.exe")).toBeVisible();
    expect(opened[0]).toMatch(/\/ws\/devices\/2\/live$/);
    await panel.screenshot({ path: testInfo.outputPath(`device-live-${theme}.png`) });
  });
}

test("an agent without the live channel says so", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the drawer is the desktop device view");
  await liveSocket(page, false);
  await page.goto("/devices");
  await page.locator("tr", { hasText: "NW-DOCTOR-02" }).getByText("NW-DOCTOR-02").first().click();
  await expect(page.getByText("Not available — the agent is offline or older than 2.1.27")).toBeVisible();
});
