import type { Page } from "@playwright/test";
import { DEVICES } from "./mockApi";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

/** A production-like Windows server (from the owner's HV-PROD-01 screenshots). */
const HV_PROD = {
  ...DEVICES[0],
  hostname: "HV-PROD-01",
  device_type: "server",
  os_name: "windows",
  platform: "windows",
  os_caption: "Microsoft Windows Server 2025 Standard Evaluation",
  os_build: "10.0.26100",
  windows_product_type: 3,
  current_user: "Administrator",
  user_source: "console_session",
  user_session_state: "active",
  cpu: "Intel64 Family 6 Model 85 Stepping 7, GenuineIntel",
  ram: "63 GB",
  storage: "85 GB free / 930 GB total",
  capabilities: { powershell: "" },
  location_id: 7,
  location_name: "HQ",
  location_city: "Durrës",
  location_country: "AL",
  location_source: "rule" as const,
  assignment_source: "manual",
};

const HEALTH = {
  device_id: 1,
  health_score: 64,
  health_state: "warning",
  latest_telemetry: null,
  reasons: ["Disk critical: 90.8%", "1 warning alert(s) open"],
};

const SECTIONS = ["Status", "Services", "Identity", "Client assignment"] as const;

async function openDrawer(page: Page, theme: "dark" | "light" = "dark") {
  await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
  await page.route(/\/api\/v1\/devices\/\?/, (route) =>
    route.fulfill({ json: { devices: [HV_PROD, ...DEVICES.slice(1)], total: DEVICES.length } }),
  );
  await page.route(/\/api\/v1\/devices\/1$/, (route) => route.fulfill({ json: HV_PROD }));
  await page.route(/\/api\/v1\/devices\/1\/health$/, (route) => route.fulfill({ json: HEALTH }));
  await page.goto("/devices");
  await page.locator("tr", { hasText: "HV-PROD-01" }).getByText("HV-PROD-01").first().click();
  const drawer = page.locator(".th-drawer-panel");
  await expect(drawer.getByText("Disk critical: 90.8%")).toBeVisible();
  await expect(drawer.getByText("63 GB")).toBeVisible();
  return drawer;
}

/** Height of each Overview section, found by its title (the first kicker in it). */
async function sectionHeights(page: Page): Promise<Record<string, number>> {
  return page.evaluate((names) => {
    const out: Record<string, number> = {};
    for (const section of Array.from(document.querySelectorAll<HTMLElement>(".th-drawer-panel section"))) {
      const title = section.querySelector(".premium-kicker")?.textContent?.trim() ?? "";
      if ((names as readonly string[]).includes(title) && !(title in out))
        out[title] = Math.round(section.getBoundingClientRect().height);
    }
    return out;
  }, SECTIONS);
}

/**
 * The same four sections before the compact layout (18 Oct 2026, this fixture,
 * 1440×900 → 720 px drawer), measured with `sectionHeights` on the old markup.
 */
const BEFORE = { Status: 207, Services: 198, Identity: 386, "Client assignment": 426 } as const;
const BEFORE_TOTAL = Object.values(BEFORE).reduce((a, b) => a + b, 0); // 1217 px

const desktopOnly = () => test.skip(test.info().project.name !== "desktop", "the drawer is the desktop device view");

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const drawer = document.querySelector<HTMLElement>(".th-drawer-panel");
    const doc = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    let inner = 0;
    for (const el of Array.from(drawer?.querySelectorAll<HTMLElement>(".th-tab-panel section") ?? [])) {
      inner = Math.max(inner, el.scrollWidth - el.clientWidth);
    }
    return Math.max(doc, inner, drawer ? drawer.scrollWidth - drawer.clientWidth : 0);
  });
}

test("the four sections take about half the height they used to", async ({ page }) => {
  desktopOnly();
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDrawer(page);
  const heights = await sectionHeights(page);
  console.log("drawer-compact heights", JSON.stringify(heights), "before", JSON.stringify(BEFORE));
  expect(Object.keys(heights).sort()).toEqual([...SECTIONS].sort());
  const total = Object.values(heights).reduce((a, b) => a + b, 0);
  expect(total).toBeLessThanOrEqual(Math.round(BEFORE_TOTAL * 0.55));
});

test("the sections are laid out compactly: pairs side by side, four service tiles in a row", async ({ page }) => {
  desktopOnly();
  await page.setViewportSize({ width: 1440, height: 900 });
  const drawer = await openDrawer(page);

  // Status: last seen and health on one line, issues as chips.
  const status = drawer.getByRole("region", { name: "Status" });
  const lastSeen = await status.locator(".th-kv-row", { hasText: "Last seen" }).boundingBox();
  const health = await status.locator(".th-kv-row", { hasText: "Warning 64" }).boundingBox();
  expect(Math.abs((lastSeen?.y ?? 0) - (health?.y ?? 1))).toBeLessThanOrEqual(1);
  await expect(status.getByRole("list", { name: "Health issues" }).getByRole("listitem")).toHaveText([
    "Disk critical: 90.8%",
    "1 warning alert(s) open",
  ]);

  // Services: four equal tiles on one line.
  const tiles = drawer.getByRole("region", { name: "Services" }).locator(".th-svc-tile");
  await expect(tiles).toHaveCount(4);
  const boxes = await Promise.all([0, 1, 2, 3].map((i) => tiles.nth(i).boundingBox()));
  for (const box of boxes) {
    expect(Math.abs((box?.y ?? 0) - (boxes[0]?.y ?? 1))).toBeLessThanOrEqual(1);
    expect(Math.abs((box?.height ?? 0) - (boxes[0]?.height ?? 1))).toBeLessThanOrEqual(1);
    expect(Math.abs((box?.width ?? 0) - (boxes[0]?.width ?? 1))).toBeLessThanOrEqual(1);
  }
  await expect(tiles.nth(0)).toContainText("Running");
  await expect(tiles.nth(0)).toContainText("v1.4.6");
  await expect(tiles.nth(1)).toHaveAttribute("title", /Patches and installed apps/);

  // Identity: hardware as three equal mini-stats in one row.
  const hw = drawer.getByRole("region", { name: "Identity" }).locator(".th-hw-stat");
  const hwBoxes = await Promise.all([0, 1, 2].map((i) => hw.nth(i).boundingBox()));
  for (const box of hwBoxes) {
    expect(Math.abs((box?.y ?? 0) - (hwBoxes[0]?.y ?? 1))).toBeLessThanOrEqual(1);
    expect(Math.abs((box?.height ?? 0) - (hwBoxes[0]?.height ?? 1))).toBeLessThanOrEqual(1);
  }

  // Client assignment: read view first; the pickers open in place, side by side.
  const assignment = drawer.getByRole("region", { name: "Client assignment" });
  await expect(assignment.getByRole("combobox")).toHaveCount(0);
  await assignment.getByRole("button", { name: "Edit assignment" }).click();
  const pickers = [
    assignment.getByRole("combobox", { name: "Assign client" }),
    assignment.getByRole("combobox", { name: "Assign location" }),
    assignment.getByRole("combobox", { name: "Assign group" }),
  ];
  const pickerBoxes = await Promise.all(pickers.map((p) => p.boundingBox()));
  for (const box of pickerBoxes) expect(Math.abs((box?.y ?? 0) - (pickerBoxes[0]?.y ?? 1))).toBeLessThanOrEqual(1);
  await assignment.getByRole("button", { name: "Done" }).click();
  await expect(assignment.getByRole("combobox")).toHaveCount(0);
});

for (const [label, width] of [
  ["720 px drawer", 1440],
  ["780 px drawer", 1600],
] as const) {
  test(`no horizontal overflow in the Overview (${label})`, async ({ page }) => {
    desktopOnly();
    await page.setViewportSize({ width, height: 900 });
    const drawer = await openDrawer(page);
    expect(Math.round((await drawer.boundingBox())?.width ?? 0)).toBe(width >= 1536 ? 780 : 720);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await drawer.getByRole("button", { name: "Edit assignment" }).click();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
}

test("no horizontal overflow at phone width (390 px)", async ({ page }) => {
  desktopOnly();
  await page.setViewportSize({ width: 1440, height: 900 });
  const drawer = await openDrawer(page);
  await drawer.getByRole("button", { name: "Edit assignment" }).click();
  // The open drawer, squeezed to a phone: pairs stack, services go 2×2.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => Math.round((await drawer.boundingBox())?.width ?? 0)).toBe(390);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  const tiles = drawer.locator(".th-svc-tile");
  const [a, c] = await Promise.all([tiles.nth(0).boundingBox(), tiles.nth(2).boundingBox()]);
  expect((c?.y ?? 0) - (a?.y ?? 0)).toBeGreaterThan(10);
  // The phone's own device page.
  await page.goto("/devices/1");
  await expect(page.getByText("HV-PROD-01").first()).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(0);
});

for (const theme of ["dark", "light"] as const) {
  test(`screenshot the Overview (${theme})`, async ({ page }) => {
    desktopOnly();
    // Tall enough for the whole Overview: the drawer scrolls inside itself.
    await page.setViewportSize({ width: 1440, height: 3200 });
    const drawer = await openDrawer(page, theme);
    const overview = drawer.locator(".th-tab-panel").first();
    const dir = process.env.DRAWER_SHOTS_DIR;
    const name = `drawer-overview-${process.env.DRAWER_SHOTS_TAG ?? "after"}-${theme}.png`;
    await overview.screenshot({ path: dir ? `${dir}/${name}` : test.info().outputPath(name) });
    await drawer.getByRole("button", { name: "Edit assignment" }).click();
    await drawer
      .getByRole("region", { name: "Client assignment" })
      .screenshot({ path: test.info().outputPath(`drawer-assignment-edit-${theme}.png`) });
  });
}
