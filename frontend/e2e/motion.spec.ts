import type { Page } from "@playwright/test";
import { DEVICES } from "./mockApi";
import { expect, test } from "./test";

/** Records every exit copy (useExitAnimation) the page adds and removes. */
async function watchExits(page: Page) {
  await page.addInitScript(() => {
    const log: string[] = [];
    (window as unknown as { __exits: string[] }).__exits = log;
    new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach(
          (n) => n instanceof HTMLElement && n.classList.contains("th-leaving") && log.push("in"),
        );
        record.removedNodes.forEach(
          (n) => n instanceof HTMLElement && n.classList.contains("th-leaving") && log.push("out"),
        );
      }
    }).observe(document, { childList: true, subtree: true });
  });
}
const exits = (page: Page) => page.evaluate(() => (window as unknown as { __exits: string[] }).__exits);

async function openAndCloseCalendar(page: Page) {
  await page.goto("/audit");
  await page.getByRole("button", { name: /^From/ }).click();
  const dialog = page.getByRole("dialog", { name: "Choose date and time" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

test.describe("exit motion", () => {
  test("a closed popover animates out and leaves nothing behind", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "desktop filter bar");
    await watchExits(page);
    await openAndCloseCalendar(page);
    await expect.poll(() => exits(page)).toEqual(["in", "out"]);
    await expect(page.locator(".th-leaving")).toHaveCount(0);
  });

  test.describe("reduced motion", () => {
    test.use({ reducedMotion: "reduce" });
    test("closes at once, without an exit copy", async ({ page }) => {
      test.skip(test.info().project.name !== "desktop", "desktop filter bar");
      await watchExits(page);
      await openAndCloseCalendar(page);
      await page.waitForTimeout(500);
      expect(await exits(page)).toEqual([]);
    });
  });
});

/** A 1000-device fleet; the table shows at most 50 a page (Devices.tsx). */
const FLEET = Array.from({ length: 1000 }, (_, i) => ({
  ...DEVICES[i % DEVICES.length],
  id: 10_000 + i,
  hostname: `PC-${String(i + 1).padStart(4, "0")}`,
}));

test("on a 1000-device fleet at 50 a page, every click and key answers within 200 ms (INP)", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "the drawer is the desktop device view");
  await page.route(/\/api\/v1\/devices\/(\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const skip = Number(url.searchParams.get("skip") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    return route.fulfill({ json: { devices: FLEET.slice(skip, skip + limit), total: FLEET.length } });
  });
  await page.addInitScript(() => {
    // INP counts interactions (clicks, taps, keys): entries with an interactionId.
    const durations: Array<{ name: string; duration: number; target: string }> = [];
    (window as unknown as { __events: typeof durations }).__events = durations;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEventTiming & { interactionId?: number }>)
        if (entry.interactionId)
          durations.push({
            name: entry.name,
            duration: entry.duration,
            target: (entry.target as Element | null)?.className?.toString().slice(0, 40) ?? "",
          });
      // durationThreshold: report every interaction, not only slow ones.
    }).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
  });
  await page.goto("/devices?limit=50");
  const row = page.locator("tr.th-device-row", { hasText: "PC-0003" });
  await expect(row).toBeVisible();

  for (let round = 0; round < 3; round++) {
    await row.locator("td").nth(2).click();
    await expect(page.locator(".th-drawer-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('.th-drawer-panel[data-open="true"]')).toHaveCount(0);
  }
  await page.getByRole("searchbox").first().fill("PC-09");

  const events = await page.evaluate(
    () => (window as unknown as { __events: Array<{ name: string; duration: number; target: string }> }).__events,
  );
  const slow = events
    .filter((e) => e.duration >= 200)
    .map((e) => `${e.name} ${Math.round(e.duration)}ms on ${e.target}`);
  console.log(`INP (slowest interaction): ${Math.round(Math.max(...events.map((e) => e.duration)))} ms`);
  expect(events.length).toBeGreaterThan(0);
  expect(slow).toEqual([]);
});
