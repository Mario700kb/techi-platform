import { DEVICES } from "./mockApi";
import { northwindProfile } from "./profileMocks";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: a client's profile shows its figures, sections and tabs`, async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "checked at desktop width; the page stacks on phones");
    await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    await northwindProfile(page);
    await page.goto("/clients/1");

    await expect(page.getByRole("heading", { name: "Northwind Clinic" })).toBeVisible();
    for (const figure of ["42", "67%", "14", "74", "7"]) {
      await expect(page.locator(".th-onb-stat", { hasText: figure }).first()).toBeVisible();
    }
    await expect(page.getByRole("heading", { name: "Fleet status" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Open alerts", exact: true })).toBeVisible();
    await expect(page.getByText("NW-RECEPTION-01").first()).toBeVisible();
    // Four overview cards in two even columns.
    const cards = page.locator('[role="tabpanel"] section.premium-card');
    await expect(cards).toHaveCount(4);
    const boxes = await cards.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
    expect(Math.max(...boxes) - Math.min(...boxes)).toBeLessThan(2);
    // Symmetric: cards side by side share one height, footers on one line.
    const rects = await cards.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()));
    expect(Math.abs(rects[0].height - rects[1].height)).toBeLessThan(2);
    expect(Math.abs(rects[2].height - rects[3].height)).toBeLessThan(2);
    const feet = await page
      .locator('[role="tabpanel"] .th-cp-foot')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().bottom));
    expect(Math.abs(feet[0] - feet[1])).toBeLessThan(2);
    // A legend row opens the Devices tab with that status selected.
    await page.locator(".th-cp-legend button", { hasText: "Offline" }).first().click();
    await expect(page.getByRole("radio", { name: /Offline/ })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("tab", { name: /Overview/ }).click();
    await page.screenshot({ path: test.info().outputPath(`profile-overview-${theme}.png`), fullPage: true });

    await page.getByRole("tab", { name: /Devices/ }).click();
    await expect(page.locator("tbody tr").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Connect to/ }).first()).toBeVisible();
    await page.getByRole("tab", { name: /Alerts/ }).click();
    await expect(page.getByRole("tab", { name: "Open" })).toBeVisible();
    await page.getByRole("tab", { name: /Activity/ }).click();
    await expect(page.getByText("NW-SRV-01").first()).toBeVisible();
    await page.getByRole("tab", { name: /Analytics/ }).click();
    // Monitoring first (client-analytics.spec.ts covers it in depth), the
    // 30-day status and alert history below, its bar chart with a legend.
    await expect(page.locator(".th-onb-stat", { hasText: "Devices reporting" })).toContainText("3 / 4");
    await expect(page.getByRole("heading", { name: "CPU by device and hour" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Availability" })).toBeVisible();
    await expect(page.locator(".th-cp-chart-meta", { hasText: "Resolved" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`profile-analytics-${theme}.png`), fullPage: true });
    await expect(page.getByRole("tab", { name: /Tickets/ })).toBeDisabled();
  });
}

test("a client row on the Clients page opens its profile", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop");
  await northwindProfile(page);
  await page.goto("/clients");
  await page.getByRole("link", { name: "Northwind Clinic", exact: true }).click();
  await expect(page).toHaveURL(/\/clients\/1$/);
  await expect(page.getByRole("heading", { name: "Northwind Clinic" })).toBeVisible();
});

test("an unknown client shows a clear message", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop");
  await page.route("**/api/v1/clients/99/**", (route) =>
    route.fulfill({ status: 404, json: { detail: "Client not found" } }),
  );
  await page.goto("/clients/99");
  await expect(page.getByText("Couldn't open this client")).toBeVisible();
});

test("a client's device connects from its row and opens the drawer in place", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "the drawer is the desktop device view");
  await northwindProfile(page);
  await page.goto("/clients/1");
  await page.getByRole("tab", { name: /Devices/ }).click();

  const row = page.locator("tr.th-cp-row", { hasText: "NW-RECEPTION-01" });
  await expect(row.getByRole("button", { name: "Connect to NW-RECEPTION-01" })).toBeEnabled();
  // Offline devices keep the button but cannot connect.
  await expect(
    page.locator("tr.th-cp-row", { hasText: "BH-WH-SCANNER" }).getByRole("button", { name: /Connect to/ }),
  ).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath("profile-devices.png") });

  await row.locator("td").first().click();
  await expect(page).toHaveURL(/\/clients\/1$/);
  const drawer = page.locator(".th-drawer-panel");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "NW-RECEPTION-01" })).toBeVisible();
  await expect(row).toHaveAttribute("data-selected", "true");
  await page.screenshot({ path: test.info().outputPath("profile-device-drawer.png") });

  await drawer.getByRole("button", { name: "Close" }).click();
  await expect(drawer).toBeHidden();

  // The status filter narrows the list.
  await page.getByRole("radio", { name: /Offline/ }).click();
  await expect(page.locator("tr.th-cp-row")).toHaveCount(1);
  await expect(page.locator("tr.th-cp-row", { hasText: "BH-WH-SCANNER" })).toBeVisible();
});

test("a long device list fits the screen and keeps its header pinned while it scrolls", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "phones show cards without a header");
  await northwindProfile(page);
  const many = Array.from({ length: 40 }, (_, i) => ({
    ...DEVICES[0],
    id: 100 + i,
    hostname: `NW-PC-${String(i + 1).padStart(2, "0")}`,
  }));
  await page.route("**/api/v1/devices/?*", (route) => route.fulfill({ json: { devices: many, total: 40 } }));
  await page.goto("/clients/1");
  await page.getByRole("tab", { name: /Devices/ }).click();
  await expect(page.locator("tr.th-cp-row")).toHaveCount(40);

  // Like the other list pages: the page itself does not scroll, the list
  // scrolls inside the space the screen leaves it, pagination in view.
  const main = page.locator(".th-main");
  expect(await main.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThan(2);
  await expect(page.getByRole("tabpanel").locator("nav.th-pagination")).toBeInViewport();
  // The client's header card keeps its full height (it once shrank to a sliver).
  const hero = (await page.locator(".th-team-hero").boundingBox())!;
  expect(hero.height).toBeGreaterThan(60);

  const wrapper = page.locator(".th-cp-scroll");
  expect(await wrapper.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100);
  const top = (await wrapper.boundingBox())!.y;
  for (const fraction of [0.5, 1]) {
    await wrapper.evaluate((el, f) => el.scrollTo({ top: (el.scrollHeight - el.clientHeight) * f }), fraction);
    const head = (await wrapper.locator("thead th").first().boundingBox())!;
    expect(Math.abs(head.y - top)).toBeLessThan(2);
  }
  await page.screenshot({ path: test.info().outputPath("profile-devices-sticky.png") });
});

test("activity shows who connected where, for how long, and filters by type and operator", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop");
  await northwindProfile(page);
  await page.goto("/clients/1");
  await page.getByRole("tab", { name: /Activity/ }).click();

  await expect(page.locator(".th-onb-stat", { hasText: "Remote connections" })).toContainText("41");
  await expect(page.locator(".th-onb-stat", { hasText: "Terminal & SSH time" })).toContainText("45 min");
  await expect(page.locator(".th-onb-stat", { hasText: "Remote Support time" })).toContainText("agent 2.1.24");
  await expect(page.getByRole("heading", { name: "Most reached devices" })).toBeVisible();

  const log = page.locator("table.th-cp-log");
  await expect(log.locator("tr.th-cp-day").first()).toContainText("Today");
  // One row per session: the row that started it, with its length and end.
  const connect = log.locator("tr.th-alerts-row", { hasText: "Remote Support session" });
  await expect(connect).toContainText("Remote Support online");
  await expect(connect).toContainText("185.66.128.121");
  await expect(connect).toContainText("Ended · closed");
  await expect(connect.locator(".th-cp-duration")).toHaveText("18 min");
  const terminal = log.locator("tr.th-alerts-row", { hasText: "Terminal session" });
  await expect(terminal).toContainText("Ended · closed by the operator");
  await expect(terminal.locator(".th-cp-duration")).toHaveText("25 min");
  const missed = log.locator("tr.th-alerts-row", { hasText: "sabina" }).filter({ hasText: "Remote connect" });
  await expect(missed.locator(".th-cp-duration")).toHaveText("No session");
  const live = log.locator("tr.th-alerts-row", { hasText: "PowerShell session" }).locator(".th-cp-duration");
  await expect(live).toHaveText(/^Live\s*·\s*(1|2|3) min$/);
  await expect(live).toHaveAttribute("data-live", "true");
  // One line, the same height and right edge as every other duration chip.
  await log.screenshot({ path: test.info().outputPath("activity-durations.png") });
  const done = await connect.locator(".th-cp-duration").boundingBox();
  const open = await live.boundingBox();
  expect(open!.height).toBeLessThanOrEqual(24);
  expect(open!.height).toBe(done!.height);
  expect(Math.abs(open!.x + open!.width - (done!.x + done!.width))).toBeLessThanOrEqual(1);
  await log.screenshot({ path: test.info().outputPath("activity-durations.png") });
  await page.screenshot({ path: test.info().outputPath("profile-activity.png"), fullPage: true });

  const requests: string[] = [];
  page.on("request", (r) => r.url().includes("/clients/1/activity?") && requests.push(r.url()));
  await page.getByRole("radio", { name: "Terminal & SSH" }).click();
  await expect.poll(() => requests.some((u) => u.includes("kind=terminal"))).toBe(true);
  // Twenty entries a page.
  expect(requests.every((u) => u.includes("limit=20&offset=0"))).toBe(true);
  await page.locator(".th-cp-meter", { hasText: "mario" }).click();
  await expect.poll(() => requests.some((u) => u.includes("operator=mario"))).toBe(true);
  await expect(page.getByRole("button", { name: "Remove operator filter mario" })).toBeVisible();
});
