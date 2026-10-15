import { DEVICES } from "./mockApi";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

const PROD_LIKE = {
  ...DEVICES[0],
  os_name: "windows",
  platform: "windows",
  os_caption: "Microsoft Windows 11 Pro",
  os_build: "10.0.26200",
  windows_product_type: 1,
  cpu: "Intel64 Family 6 Model 85 Stepping 4, GenuineIntel",
  ram: "7 GB",
  storage: "76 GB free / 149 GB total",
};

test("the drawer names the Windows release and lists CPU, memory and storage apart", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "the drawer is the desktop device view");
  await page.route(/\/api\/v1\/devices\/\?/, (route) =>
    route.fulfill({ json: { devices: [PROD_LIKE, ...DEVICES.slice(1)], total: DEVICES.length } }),
  );
  await page.route(/\/api\/v1\/devices\/1$/, (route) => route.fulfill({ json: PROD_LIKE }));
  await page.goto("/devices");
  await page.locator("tr", { hasText: "NW-RECEPTION-01" }).getByText("NW-RECEPTION-01").first().click();

  const identity = page.locator(".th-drawer-card").filter({ hasText: "Current user" });
  await expect(identity).toContainText("Windows 11 Pro");
  await expect(identity).toContainText("25H2 · build 26200");
  await expect(identity).toContainText("Platform");
  await expect(identity).toContainText("Windows");

  const hw = identity.locator(".th-hw");
  await expect(hw.locator("dt")).toHaveText(["CPU", "Memory", "Storage"]);
  await expect(hw.locator("dd").nth(0)).toContainText("Intel · Skylake-SP / Cascade Lake (Xeon)");
  await expect(hw.locator("dd").nth(0)).toContainText("Intel64 Family 6 Model 85 Stepping 4");
  await expect(hw.locator("dd").nth(1)).toHaveText("7 GB");
  await expect(hw.locator("dd").nth(2)).toContainText("149 GB · 76 GB free");
  await expect(hw.getByRole("img", { name: "49% used" })).toBeVisible();
  await identity.scrollIntoViewIfNeeded();
  await identity.screenshot({ path: test.info().outputPath("drawer-identity.png") });
});
