import { northwindProfile } from "./profileMocks";
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

const EVENTS = {
  total: 8729,
  items: Array.from({ length: 50 }, (_, i) => ({
    id: 9000 - i,
    operator_id: 1,
    operator_username: "denis",
    action: i % 2 ? "remote_connect" : "action_queued",
    entity_type: "device",
    entity_id: 924,
    details_json: null,
    created_at: new Date(Date.now() - i * 60_000).toISOString(),
  })),
};

// The Audit page has a filter card above the table; on screens tall enough the
// events table still ends at the window bottom with the pagination in view.
for (const screen of [
  { name: "large monitor", width: 2560, height: 1265 },
  { name: "full HD", width: 1920, height: 1080 },
]) {
  test(`the audit table fits a ${screen.name} (${screen.width}×${screen.height})`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "phones keep the page scroll");
    await page.setViewportSize({ width: screen.width, height: screen.height });
    await page.route("**/api/v1/audit?**", (route) => route.fulfill({ json: EVENTS }));
    await page.goto("/audit");
    await expect(page.getByText(/Showing 1–\d+ of 8,729 events/)).toBeInViewport();

    const card = page.locator(".th-page-fill > .th-alerts-card");
    const box = await card.boundingBox();
    const gap = screen.height - (box!.y + box!.height);
    expect(gap, "the card ends near the bottom of the window").toBeLessThan(40);
    expect(gap).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`audit-${screen.width}x${screen.height}.png`) });
  });
}

test("on a laptop the audit page still reaches its pagination", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "phones keep the page scroll");
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route("**/api/v1/audit?**", (route) => route.fulfill({ json: EVENTS }));
  await page.goto("/audit");
  const pagination = page.getByText(/Showing 1–\d+ of 8,729 events/);
  await pagination.scrollIntoViewIfNeeded();
  await expect(pagination).toBeInViewport();
});

// A client's profile: the devices and alerts tabs fill the screen the same
// way; the overview keeps the normal page scroll.
for (const screen of [
  { name: "large monitor", width: 2560, height: 1265 },
  { name: "full HD", width: 1920, height: 1080 },
]) {
  test(`the client profile lists fit a ${screen.name} (${screen.width}×${screen.height})`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "phones keep the page scroll");
    await page.setViewportSize({ width: screen.width, height: screen.height });
    await northwindProfile(page);
    await page.goto("/clients/1");
    for (const tab of [/Devices/, /Alerts/]) {
      await page.getByRole("tab", { name: tab }).first().click();
      const panel = page.getByRole("tabpanel");
      await expect(panel.locator(".th-alerts-card")).toBeVisible();
      // Devices pages its list; its pagination stays on screen.
      if (tab.source === "Devices") await expect(panel.locator("nav.th-pagination")).toBeInViewport();
      const box = await panel.boundingBox();
      const gap = screen.height - (box!.y + box!.height);
      expect(gap, "the list ends near the bottom of the window").toBeLessThan(40);
      expect(gap).toBeGreaterThanOrEqual(0);
    }
    await page
      .getByRole("tab", { name: /Overview/ })
      .first()
      .click();
    await expect(page.locator("section.premium-page")).not.toHaveClass(/th-page-fill/);
  });
}

// On a 768px-tall laptop the profile's header leaves too little for a list
// box, so the list grows with the page as before: the header card keeps its
// height and the pagination is reached by scrolling the page.
test("on a laptop the client profile list grows with the page", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "phones keep the page scroll");
  await page.setViewportSize({ width: 1366, height: 768 });
  await northwindProfile(page);
  await page.goto("/clients/1");
  await page
    .getByRole("tab", { name: /Devices/ })
    .first()
    .click();
  const hero = (await page.locator(".th-team-hero").boundingBox())!;
  expect(hero.height).toBeGreaterThan(60);
  const pagination = page.getByRole("tabpanel").locator("nav.th-pagination");
  await pagination.scrollIntoViewIfNeeded();
  await expect(pagination).toBeInViewport();
});
