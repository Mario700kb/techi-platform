import type { Page } from "@playwright/test";

import { DEVICES, overview } from "./mockApi";
import { northwindProfile } from "./profileMocks";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

// Northwind (client 1) with two sites in Tiranë and a branch in Durrës.
const SITES = [
  { id: 11, client_id: 1, name: "Tiranë – Zyra qendrore", kind: "office", country: "AL", city: "Tiranë" },
  { id: 12, client_id: 1, name: "Tiranë – Magazina", kind: "warehouse", country: "AL", city: "Tiranë" },
  { id: 13, client_id: 1, name: "Durrës – Dega", kind: "branch", country: "AL", city: "Durrës" },
];

const stats = (total: number, online: number, servers = 0) => ({
  total,
  online,
  stale: 0,
  offline: total - online,
  servers,
  clientpc: total - servers,
});

const LOCATION_LIST = {
  locations: [
    {
      ...SITES[2],
      address: "Rr. Tregtare 4",
      contact: "Erion · +355 69 000 0000",
      notes: null,
      rules: [{ id: 3, public_ip: "84.22.48.82", lan_cidr: null }],
      stats: stats(11, 9, 1),
      manual_devices: 0,
      created_at: "2026-10-15T08:00:00Z",
      updated_at: "2026-10-15T08:00:00Z",
    },
    {
      ...SITES[1],
      address: null,
      contact: null,
      notes: null,
      rules: [{ id: 2, public_ip: "80.90.87.187", lan_cidr: "10.130.50.0/24" }],
      stats: stats(21, 20),
      manual_devices: 1,
      created_at: "2026-10-15T08:00:00Z",
      updated_at: "2026-10-15T08:00:00Z",
    },
    {
      ...SITES[0],
      address: "Rr. Myslym Shyri 12",
      contact: null,
      notes: null,
      rules: [{ id: 1, public_ip: "80.90.87.187", lan_cidr: null }],
      stats: stats(38, 31, 7),
      manual_devices: 0,
      created_at: "2026-10-15T08:00:00Z",
      updated_at: "2026-10-15T08:00:00Z",
    },
  ],
  unlocated: stats(4, 2),
};

const SUGGESTIONS = [
  {
    public_ip: "79.106.2.28",
    devices: 8,
    online: 6,
    networks: [
      { lan_cidr: "10.170.1.0/24", devices: 5 },
      { lan_cidr: "10.170.2.0/24", devices: 3 },
    ],
    other_network_devices: 0,
    sample_hostnames: ["ARCH-01", "ARCH-02", "MUDO-PC"],
  },
];

async function withSites(page: Page) {
  const site = (total: number, online: number, byCategory: Record<string, Record<string, number>>) => ({
    total,
    online,
    stale: 0,
    offline: total - online,
    by_category_platform: byCategory,
  });
  await page.route("**/api/v1/devices/overview", (route) =>
    route.fulfill({
      json: {
        ...overview,
        tree_counts: {
          ...overview.tree_counts,
          locations: SITES,
          by_client_location: {
            "1": {
              "11": site(2, 2, { clientpc: { windows: 1 }, servers: { windows: 1 } }),
              "12": site(1, 0, { clientpc: { windows: 1 } }),
              "13": site(0, 0, {}),
            },
          },
        },
      },
    }),
  );
}

const desktopOnly = () =>
  test.skip(test.info().project.name !== "desktop", "the Explorer is a desktop panel; phones have their own test");

test("the Explorer shows a client's cities, sites and their categories, and filters by them", async ({ page }) => {
  desktopOnly();
  await page.addInitScript(() => window.localStorage.setItem("techi.devices.explorer", "open"));
  await withSites(page);
  const requests: string[] = [];
  page.on("request", (r) => /\/api\/v1\/devices\/\?/.test(r.url()) && requests.push(r.url()));
  await page.goto("/devices");
  const explorer = page.getByRole("complementary", { name: "Device explorer" });

  await explorer.getByRole("button", { name: /Northwind Clinic/ }).click();
  // Tiranë holds two sites, so it gets a city row; Durrës has one, shown by name.
  const tirana = explorer.getByRole("button", { name: /(^|\s)Tiranë \d+$/ });
  await expect(tirana).toBeVisible();
  await expect(explorer.getByRole("button", { name: /Durrës – Dega/ })).toBeVisible();
  // Category folders now live under each site, not under the client.
  await expect(explorer.getByRole("button", { name: /^Servers/ })).toHaveCount(0);

  await tirana.click();
  await expect(page).toHaveURL(/folder=client-1-locs-11\.12/);
  await expect.poll(() => requests.some((u) => u.includes("location_ids=11%2C12"))).toBe(true);

  // Under the city row a site drops the city from its name.
  const hq = explorer.getByRole("button", { name: /\bZyra qendrore \d+$/ });
  await hq.click();
  await expect(page).toHaveURL(/folder=client-1-loc-11(&|$)/);
  await expect.poll(() => requests.some((u) => /client_id=1&.*location_ids=11(&|$)/.test(u))).toBe(true);

  await explorer.getByRole("button", { name: /^Servers/ }).click();
  await expect(page).toHaveURL(/folder=client-1-loc-11-servers/);
  await expect
    .poll(() => requests.some((u) => u.includes("location_ids=11") && u.includes("category=servers")))
    .toBe(true);

  // A reload reopens the branch down to the selected folder.
  await page.reload();
  await expect(
    page.getByRole("complementary", { name: "Device explorer" }).getByRole("button", { name: /^Servers/ }),
  ).toHaveAttribute("aria-current", "true");
  await page.getByRole("complementary", { name: "Device explorer" }).screenshot({
    path: test.info().outputPath("explorer-sites.png"),
  });
});

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: the Locations tab lists sites by city, suggests new ones and creates them`, async ({ page }) => {
    desktopOnly();
    await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    await northwindProfile(page);
    await page.route("**/api/v1/clients/1/locations/suggestions", (route) => route.fulfill({ json: SUGGESTIONS }));
    let created: unknown = null;
    await page.route("**/api/v1/clients/1/locations", async (route) => {
      if (route.request().method() === "POST") {
        created = route.request().postDataJSON();
        await route.fulfill({
          status: 201,
          json: { ...LOCATION_LIST.locations[2], id: 14, name: "Tiranë – Arkitektura", stats: stats(5, 4) },
        });
        return;
      }
      await route.fulfill({ json: LOCATION_LIST });
    });

    await page.goto("/clients/1");
    await page.getByRole("tab", { name: /Locations/ }).click();

    // Sites grouped by city, each with devices, status, rules and actions.
    await expect(page.getByText("3 sites in 2 cities")).toBeVisible();
    const hq = page.locator(".th-loc-card", { hasText: "Tiranë – Zyra qendrore" });
    await expect(hq).toContainText("38");
    // City and country on the card itself: a city with one site takes no row of its own.
    await expect(hq.locator("header")).toContainText("AL");
    await expect(hq.locator("header")).toContainText("Tiranë · Rr. Myslym Shyri 12");
    await expect(hq).toContainText("31 Client PCs · 7 Servers");
    await expect(page.locator(".th-loc-card", { hasText: "Durrës – Dega" })).toContainText("10 Client PCs · 1 Server");
    await expect(hq.locator(".th-loc-rule")).toContainText("80.90.87.187");
    await expect(page.locator(".th-loc-card", { hasText: "Tiranë – Magazina" })).toContainText("1 placed by hand");
    await expect(page.locator(".th-loc-unlocated")).toContainText("4 devices at no location");
    await page.locator('[role="tabpanel"]').screenshot({ path: test.info().outputPath(`locations-${theme}.png`) });

    // A suggestion's network starts a form with its IP and LAN.
    await page.locator(".th-loc-chip", { hasText: "10.170.2.0/24" }).click();
    const dialog = page.getByRole("dialog", { name: "New location" });
    await expect(dialog.getByRole("textbox", { name: "Rule 1 public IP" })).toHaveValue("79.106.2.28");
    await expect(dialog.getByRole("textbox", { name: "Rule 1 LAN network" })).toHaveValue("10.170.2.0/24");

    // The form refuses what the API would.
    await dialog.getByRole("button", { name: "Create location" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Give the location a name");
    await dialog.getByRole("textbox", { name: "Name" }).fill("Tiranë – Arkitektura");
    await dialog.getByRole("combobox", { name: "City" }).fill("Tiranë");
    await dialog.getByRole("textbox", { name: "Rule 1 LAN network" }).fill("10.170.2.0/99");
    await dialog.getByRole("button", { name: "Create location" }).click();
    await expect(dialog.getByRole("alert")).toContainText("is not a network");
    await dialog.getByRole("textbox", { name: "Rule 1 LAN network" }).fill("10.170.2.0/24");
    await page.screenshot({ path: test.info().outputPath(`location-form-${theme}.png`) });
    await dialog.getByRole("button", { name: "Create location" }).click();

    await expect(dialog).toHaveCount(0);
    expect(created).toEqual({
      name: "Tiranë – Arkitektura",
      kind: "office",
      country: "AL",
      city: "Tiranë",
      address: null,
      contact: null,
      notes: null,
      rules: [{ public_ip: "79.106.2.28", lan_cidr: "10.170.2.0/24" }],
    });
    await expect(page.getByRole("status").filter({ hasText: "5 devices at this location" })).toBeVisible();
  });
}

test("on a phone the sites stack in one column and nothing scrolls sideways", async ({ page }) => {
  test.skip(test.info().project.name !== "mobile");
  await northwindProfile(page);
  await page.route("**/api/v1/clients/1/locations/suggestions", (route) => route.fulfill({ json: SUGGESTIONS }));
  await page.route("**/api/v1/clients/1/locations", (route) => route.fulfill({ json: LOCATION_LIST }));
  await page.goto("/clients/1");
  await page.getByRole("tab", { name: /Locations/ }).click();
  const cards = page.locator(".th-loc-card");
  await expect(cards).toHaveCount(3);
  const lefts = await cards.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
  expect(new Set(lefts).size).toBe(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole("button", { name: "Add location" })).toBeVisible();
  await page.locator('[role="tabpanel"]').screenshot({ path: test.info().outputPath("locations-phone.png") });
});

test("the Devices table shows each device's site as country, city and site", async ({ page }) => {
  desktopOnly();
  const sited = DEVICES.map((d, i) =>
    i === 0
      ? {
          ...d,
          location_id: 12,
          location_name: "Durrës – Magazina",
          location_city: "Durrës",
          location_country: "AL",
          location_source: "rule",
        }
      : d,
  );
  await page.route(/\/api\/v1\/devices\/\?/, (route) =>
    route.fulfill({ json: { devices: sited, total: sited.length } }),
  );
  await page.goto("/devices");
  await expect(page.getByRole("columnheader", { name: "Client / location" })).toBeVisible();
  const row = page.getByRole("row", { name: /NW-RECEPTION-01/ });
  const site = row.locator(".th-site-line");
  await expect(site).toContainText("AL");
  await expect(site).toContainText("Durrës · Magazina");
  await expect(site).toHaveAttribute("title", "Durrës – Magazina · Durrës, Albania · by rule");
  // Without a site the group shows, as before.
  await expect(page.getByRole("row", { name: /NW-DOCTOR-02/ })).toContainText("Front desk");
  await page
    .locator("table")
    .first()
    .screenshot({ path: test.info().outputPath("table-sites.png") });
});

test("the client's Devices tab shows each device's type under its name and its site", async ({ page }) => {
  desktopOnly();
  await northwindProfile(page);
  const sited = DEVICES.map((d) =>
    d.client_id === 1
      ? { ...d, location_id: 12, location_name: "Durrës – Magazina", location_city: "Durrës", location_country: "AL" }
      : d,
  );
  await page.route(/\/api\/v1\/devices\/\?/, (route) =>
    route.fulfill({ json: { devices: sited, total: sited.length } }),
  );
  await page.goto("/clients/1");
  await page.getByRole("tab", { name: /^Devices/ }).click();
  const server = page.getByRole("row", { name: /NW-SRV-01/ });
  await expect(server.locator("td").first()).toContainText("Server");
  await expect(
    page
      .getByRole("row", { name: /NW-RECEPTION-01/ })
      .locator("td")
      .first(),
  ).toContainText("Client PC");
  await expect(server.locator(".th-site-line")).toContainText("Durrës · Magazina");
  await page
    .getByRole("tabpanel")
    .locator("table")
    .screenshot({ path: test.info().outputPath("profile-devices.png") });
});

test("a device is placed by hand from its drawer, even at a site made on the spot", async ({ page }) => {
  desktopOnly();
  // Northwind has no location yet.
  await page.route("**/api/v1/clients/1/locations", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 201,
        json: { ...LOCATION_LIST.locations[1], id: 21, name: "Durrës – Magazina", city: "Durrës", rules: [] },
      });
      return;
    }
    await route.fulfill({ json: { locations: [], unlocated: stats(3, 2) } });
  });
  let assigned: unknown = null;
  await page.route("**/api/v1/clients/1/locations/assign", async (route) => {
    assigned = route.request().postDataJSON();
    await route.fulfill({ json: { assigned: 1, cleared: 0 } });
  });
  let placed = false;
  await page.route(/\/api\/v1\/devices\/1$/, (route) =>
    route.fulfill({
      json: placed
        ? {
            ...DEVICES[0],
            location_id: 21,
            location_name: "Durrës – Magazina",
            location_city: "Durrës",
            location_country: "AL",
            location_source: "manual",
          }
        : DEVICES[0],
    }),
  );

  await page.goto("/devices");
  await page.locator("tr", { hasText: "NW-RECEPTION-01" }).getByText("NW-RECEPTION-01").first().click();
  // Overview → Client assignment, where the device's client and group are set.
  const picker = page.getByRole("combobox", { name: "Assign location" });
  await expect(picker).toBeVisible();
  await picker.click();
  await expect(page.getByRole("option")).toHaveText([
    "By the rules (automatic)",
    "No location (keep it here)",
    "+ New location…",
  ]);
  await page.getByRole("option", { name: "+ New location…" }).click();
  const dialog = page.getByRole("dialog", { name: "New location" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Durrës – Magazina");
  await dialog.getByRole("combobox", { name: "City" }).fill("Durrës");
  placed = true;
  await dialog.getByRole("button", { name: "Create location" }).click();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => assigned).toEqual({ device_ids: [1], location_id: 21, mode: "manual" });
  await expect(page.getByText("Durrës – Magazina · Durrës, Albania · placed by hand").first()).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Assign location" })).toContainText("Durrës – Magazina");
  await page.getByRole("combobox", { name: "Assign location" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("drawer-location.png") });
});

test("many sites scroll inside their own area while the profile above stays put", async ({ page }) => {
  desktopOnly();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await northwindProfile(page);
  const many = Array.from({ length: 14 }, (_, i) => ({
    ...LOCATION_LIST.locations[2],
    id: 100 + i,
    name: `Site ${String(i + 1).padStart(2, "0")}`,
    city: ["Tiranë", "Durrës", "Vlorë", "Shkodër", "Prishtinë", "Podgoricë", "Frankfurt"][i % 7],
  }));
  await page.route("**/api/v1/clients/1/locations/suggestions", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/clients/1/locations", (route) =>
    route.fulfill({ json: { locations: many, unlocated: stats(0, 0) } }),
  );
  await page.goto("/clients/1");
  await page.getByRole("tab", { name: /Locations/ }).click();
  await expect(page.locator(".th-loc-card")).toHaveCount(14);

  const area = page.locator(".th-loc-scroll");
  await expect(area).toHaveAttribute("data-fill", "true");
  const sizes = await page.evaluate(() => {
    const main = document.querySelector(".th-main") as HTMLElement;
    const list = document.querySelector(".th-loc-scroll") as HTMLElement;
    return {
      pageOverflow: main.scrollHeight - main.clientHeight,
      listOverflow: list.scrollHeight - list.clientHeight,
      listBottom: Math.round(list.getBoundingClientRect().bottom),
      pageBottom: Math.round(main.getBoundingClientRect().bottom),
    };
  });
  expect(sizes.pageOverflow).toBeLessThanOrEqual(1);
  expect(sizes.listOverflow).toBeGreaterThan(100);
  // The list ends where the page area does (less its bottom padding).
  expect(sizes.pageBottom - sizes.listBottom).toBeLessThanOrEqual(24);

  // Scrolling the list leaves the toolbar where it was.
  const toolbar = page.getByRole("button", { name: "Add location" });
  const before = (await toolbar.boundingBox())!.y;
  await area.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => area.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect((await toolbar.boundingBox())!.y).toBe(before);
  await page.screenshot({ path: test.info().outputPath("locations-scroll.png") });
});

test("the Locations search finds sites by name, place, country, kind and rule", async ({ page }) => {
  desktopOnly();
  await northwindProfile(page);
  await page.route("**/api/v1/clients/1/locations/suggestions", (route) => route.fulfill({ json: SUGGESTIONS }));
  await page.route("**/api/v1/clients/1/locations", (route) => route.fulfill({ json: LOCATION_LIST }));
  await page.goto("/clients/1");
  await page.getByRole("tab", { name: /Locations/ }).click();
  const search = page.getByRole("textbox", { name: "Search locations" });
  const cards = page.locator(".th-loc-card h3");
  await expect(cards).toHaveCount(3);

  await search.fill("durrës");
  await expect(cards).toHaveText(["Durrës – Dega"]);
  await expect(page.getByText("1 of 3 sites match")).toBeVisible();

  await search.fill("80.90.87");
  await expect(cards).toHaveText(["Tiranë – Magazina", "Tiranë – Zyra qendrore"]);
  await search.fill("10.130.50");
  await expect(cards).toHaveText(["Tiranë – Magazina"]);
  await search.fill("albania warehouse");
  await expect(cards).toHaveText(["Tiranë – Magazina"]);
  // The suggestion's IP and networks are searched too; the unlocated card waits.
  await search.fill("10.170.2");
  await expect(page.locator(".th-loc-suggestions li")).toHaveCount(1);
  await expect(page.locator(".th-loc-unlocated")).toHaveCount(0);

  await search.fill("skopje");
  await expect(page.getByText("No location matches “skopje”")).toBeVisible();
  await expect(page.locator(".th-loc-suggestions li")).toHaveCount(0);
  await page.getByRole("button", { name: "Clear search" }).first().click();
  await expect(cards).toHaveCount(3);

  await search.fill("dega");
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(cards).toHaveCount(3);
  await page.locator("[role=tabpanel]").screenshot({ path: test.info().outputPath("locations-search.png") });
});
