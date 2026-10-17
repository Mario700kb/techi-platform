import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

const MANY = Array.from({ length: 39 }, (_, i) => ({
  id: 100 + i,
  name: `Client ${String(i + 1).padStart(2, "0")}`,
  slug: `client-${i + 1}`,
  is_active: true,
  created_at: "2026-06-01T00:00:00Z",
}));

// The Clients table fills whatever screen it is on: it ends at the bottom of
// the window (no empty band below a fixed 640px box) and its rows scroll
// inside, the pagination staying in view.
for (const screen of [
  { name: "large monitor", width: 2560, height: 1265 },
  { name: "full HD", width: 1920, height: 1080 },
  { name: "laptop", width: 1366, height: 768 },
]) {
  test(`the clients table fits a ${screen.name} (${screen.width}×${screen.height})`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "phones keep the page scroll");
    await page.setViewportSize({ width: screen.width, height: screen.height });
    await page.route("**/api/v1/clients", (route) => route.fulfill({ json: MANY }));
    await page.goto("/clients");
    await expect(page.getByText("Client 01", { exact: true })).toBeVisible();

    const card = page.locator(".th-page-fill > .th-alerts-card");
    const box = await card.boundingBox();
    expect(box, "the table card is on screen").not.toBeNull();
    const gap = screen.height - (box!.y + box!.height);
    expect(gap, "the card ends near the bottom of the window").toBeLessThan(40);
    expect(gap).toBeGreaterThanOrEqual(0);
    await expect(page.getByText(/Showing 1–25 of 39 clients/)).toBeInViewport();

    const scroll = card.locator(".th-alerts-scroll");
    const fits = await scroll.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
    expect(fits.client, "the rows get the space the screen has").toBeGreaterThan(screen.height * 0.35);
    await page.screenshot({ path: testInfo.outputPath(`clients-${screen.width}x${screen.height}.png`) });
  });
}
