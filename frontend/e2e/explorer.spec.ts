import { overview } from "./mockApi";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

test.beforeEach(async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "the Explorer is a desktop panel");
  await page.addInitScript(() => window.localStorage.setItem("techi.devices.explorer", "open"));
});

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: clients carry a status ring, single platforms fold into their folder`, async ({ page }) => {
    await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    await page.goto("/devices");
    const explorer = page.getByRole("complementary", { name: "Device explorer" });

    await expect(explorer.getByRole("img", { name: "2 online · 1 stale · 0 offline" })).toBeVisible();
    await expect(explorer.getByRole("img", { name: "1 online · 0 stale · 1 offline" })).toBeVisible();

    const northwind = explorer.getByRole("button", { name: /Northwind Clinic/ });
    await northwind.click();
    await expect(northwind).toHaveAttribute("aria-current", "true");
    // Selected: a neutral tint only — no coral fill, border or side bar.
    await expect(northwind).toHaveCSS("box-shadow", "none");

    const clientPcs = explorer.getByRole("button", { name: /Client PCs/ }).first();
    await expect(clientPcs).toBeVisible();
    await expect(clientPcs.locator(".th-tree-platform")).toHaveAttribute("title", "Windows");
    await expect(explorer.getByRole("button", { name: /^Windows/ })).toHaveCount(0);

    // A name that fits gets no tooltip over the rows below it.
    const label = northwind.locator("span.truncate");
    await label.hover();
    await expect(label).toHaveAttribute("title", "");

    await explorer.screenshot({ path: test.info().outputPath(`explorer-${theme}.png`) });
  });
}

test("a folder with several platforms keeps one row per platform", async ({ page }) => {
  await page.route("**/api/v1/devices/overview", (route) =>
    route.fulfill({
      json: {
        ...overview,
        tree_counts: {
          ...overview.tree_counts,
          by_client_category_platform: {
            ...overview.tree_counts.by_client_category_platform,
            "2": { clientpc: { windows: 1, linux: 1 } },
          },
        },
      },
    }),
  );
  await page.goto("/devices");
  const explorer = page.getByRole("complementary", { name: "Device explorer" });
  await explorer.getByRole("button", { name: /Blue Harbor Logistics/ }).click();
  await expect(explorer.getByRole("button", { name: /^Windows/ })).toBeVisible();
  await expect(explorer.getByRole("button", { name: /^Linux/ })).toBeVisible();
});
