import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

const SCREENS = [
  "/",
  "/devices",
  "/devices/1",
  "/alerts",
  "/more",
  "/settings",
  "/clients",
  "/audit",
  "/reports",
  "/onboarding",
  "/operators",
  "/teams",
  "/reenrollment",
  "/monitoring",
  "/automation",
  "/agent-config",
  "/notifications",
  "/vault",
];

test.describe("every screen on a phone", () => {
  test.skip(({ isMobile }) => !isMobile, "the phone layout");

  for (const path of SCREENS) {
    for (const width of [360, 412]) {
      test(`${path} stays within a ${width}px screen`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        const overflow = await page.evaluate(() => {
          const main = document.querySelector("main")!;
          return main.scrollWidth - main.clientWidth + document.documentElement.scrollWidth - innerWidth;
        });
        expect(overflow).toBeLessThanOrEqual(0);
      });
    }
  }

  test("the dock floats clear of the screen edges and never hides the end of a page", async ({ page }) => {
    await page.goto("/more");
    const dock = (await page.locator(".th-mnav").boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(dock.x).toBeGreaterThanOrEqual(8);
    expect(viewport.height - (dock.y + dock.height)).toBeGreaterThanOrEqual(8);
    const signOut = page.getByRole("button", { name: "Sign out" });
    await signOut.scrollIntoViewIfNeeded();
    const button = (await signOut.boundingBox())!;
    await page.locator("main").evaluate((main) => main.scrollTo(0, main.scrollHeight));
    const after = (await signOut.boundingBox())!;
    expect(after.y + after.height).toBeLessThanOrEqual((await page.locator(".th-mnav").boundingBox())!.y);
    expect(button.height).toBeGreaterThanOrEqual(44);
  });

  test("More keeps the admin pages behind one row, and they still open", async ({ page }) => {
    await page.goto("/more");
    await expect(page.getByRole("button", { name: "Operators" })).toHaveCount(0);
    await expect(page.getByText("Desktop only")).toHaveCount(0);
    await page.getByRole("button", { name: /Admin pages/ }).click();
    await page.getByRole("button", { name: "Operators" }).click();
    await expect(page).toHaveURL(/\/operators$/);
  });

  test("a device card gives the name its own line and keeps Connect one tap away", async ({ page }) => {
    await page.goto("/devices");
    const card = page.locator(".th-device-card").first();
    const name = card.getByRole("button", { name: "NW-RECEPTION-01" });
    await expect(name).toBeVisible();
    const clipped = await name.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped).toBe(false);
    const connect = (await card.getByRole("button", { name: /Connect/ }).boundingBox())!;
    expect(connect.height).toBeGreaterThanOrEqual(44);
    expect(connect.y).toBeGreaterThan((await name.boundingBox())!.y);
  });

  test("the audit log opens on its events; filters wait behind one row", async ({ page }) => {
    await page.goto("/audit");
    const select = page.getByRole("combobox", { name: "Filter by operator" });
    await expect(select).toBeHidden();
    await expect(page.getByText("ana.owner", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Filters" }).click();
    await expect(select).toBeVisible();
  });

  test("operators are cards, with nothing drawn over their names", async ({ page }) => {
    await page.goto("/operators");
    await expect(page.getByText("Ana Owner").first()).toBeVisible();
    await expect(page.locator(".th-alerts-table thead")).toBeHidden();
    const position = await page
      .locator(".th-alerts-table tbody td")
      .first()
      .evaluate((td) => getComputedStyle(td).position);
    expect(position).toBe("static");
  });
});

test.describe("the same pages on a desktop", () => {
  test.skip(({ isMobile }) => isMobile, "the desktop layout");

  test("filters stay open with no toggle, and admin pages are in the sidebar", async ({ page }) => {
    await page.goto("/audit");
    await expect(page.getByRole("combobox", { name: "Filter by operator" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeHidden();
    await expect(page.locator(".th-mnav")).toBeHidden();
  });

  test("a device still has its table, not phone cards", async ({ page }) => {
    await page.goto("/operators");
    await expect(page.locator(".th-alerts-table thead")).toBeVisible();
  });
});
