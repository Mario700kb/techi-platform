import { DEVICES } from "./mockApi";
import { expect, test } from "./test";

// "No heartbeat · 2d ago · Network" stretched the Status column and the
// Devices table needed a horizontal scroll (owner, 18 Oct).
test("a long offline status stays in its column and the table needs no sideways scroll", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the Devices table is the desktop view");
  await page.setViewportSize({ width: 1280, height: 720 });
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  const devices = DEVICES.map((d, i) =>
    i === 0 ? { ...d, status: "offline", freshness_state: "offline", last_seen: twoDaysAgo, offline_reason: null } : d,
  );
  await page.route(
    (url) => url.pathname === "/api/v1/devices/",
    (route) => route.fulfill({ json: { devices, total: devices.length } }),
  );
  await page.goto("/devices");
  const status = page.locator("tr", { hasText: devices[0].hostname! }).getByTestId("device-status").first();
  await expect(status).toContainText("Offline");

  await page
    .locator("tr", { hasText: devices[0].hostname! })
    .screenshot({ path: testInfo.outputPath("status-row.png") });
  const box = await status.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(140);
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("table")].map((t) => {
      const scroller = t.closest<HTMLElement>("[class*='overflow']") ?? t.parentElement!;
      return scroller.scrollWidth - scroller.clientWidth;
    }),
  );
  expect(Math.max(...overflow)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
