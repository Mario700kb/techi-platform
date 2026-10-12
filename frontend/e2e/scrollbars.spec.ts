import { expect, test } from "./test";

// Headless Chromium hides scrollbars by default (overlay, 0 px), which would
// make this test pass whatever the CSS says; show real 15 px bars instead.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test.beforeEach(() => {
  test.skip(test.info().project.name !== "desktop", "phones use overlay scrollbars");
});

test("the main area scrolls with no visible vertical scrollbar", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 480 });
  await page.goto("/");
  const main = page.locator("main.th-main");
  await expect(main).toBeVisible();

  const metrics = await main.evaluate((el) => ({
    scrollable: el.scrollHeight > el.clientHeight,
    scrollbarWidth: (el as HTMLElement).offsetWidth - el.clientWidth,
  }));
  expect(metrics.scrollable).toBe(true);
  expect(metrics.scrollbarWidth).toBe(0);

  await main.hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test("a wide table keeps its horizontal scrollbar", async ({ page }) => {
  // Narrow enough that the desktop device table no longer fits.
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/devices");
  await expect(page.getByText("NW-RECEPTION-01").filter({ visible: true }).first()).toBeVisible();

  const bars = await page.evaluate(() => {
    const wide = [...document.querySelectorAll<HTMLElement>("*")].find((el) => {
      const style = getComputedStyle(el);
      return /(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1 && el.clientHeight > 0;
    });
    return wide ? { horizontal: wide.offsetHeight - wide.clientHeight } : null;
  });
  expect(bars, "a horizontally scrolling container on /devices").not.toBeNull();
  expect(bars!.horizontal).toBeGreaterThan(0);
});
