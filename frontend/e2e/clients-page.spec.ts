import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: clients page leads with the list; forms open in dialogs`, async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "desktop layout");
    await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    await page.goto("/clients");

    const table = page.locator("table.th-alerts-table").first();
    await expect(table.getByText("Northwind Clinic")).toBeVisible();
    // No create forms on the page itself.
    await expect(page.getByPlaceholder("e.g. Vasgroup")).toHaveCount(0);
    // Devices column: count, share online and the status bar.
    const northwind = table.locator("tr", { hasText: "Northwind Clinic" });
    await expect(northwind.getByText(/% online/)).toBeVisible();
    await expect(northwind.locator(".th-client-bar > span")).toHaveCount(3);
    await page.screenshot({ path: test.info().outputPath(`clients-${theme}.png`) });

    await page.getByRole("button", { name: "New client" }).click();
    await expect(page.getByRole("dialog", { name: "New client" })).toBeVisible();
    await expect(page.getByPlaceholder("e.g. Vasgroup")).toBeFocused();
    await page.screenshot({ path: test.info().outputPath(`clients-new-${theme}.png`) });
    await page.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("tab", { name: /Domain mappings/ }).click();
    await expect(page.getByRole("button", { name: "Add mapping" })).toBeVisible();
  });
}
