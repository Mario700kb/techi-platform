import { DEVICES } from "./mockApi";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

test("latest enrollments show the newest 50, ten, twenty or fifty to a page", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "the enrollments card is on the desktop dashboard");
  const enrolled = Array.from({ length: 50 }, (_, i) => ({
    ...DEVICES[0],
    id: 1000 - i,
    hostname: `NEW-PC-${String(i + 1).padStart(2, "0")}`,
  }));
  const asked: string[] = [];
  await page.route("**/api/v1/devices/?*", (route) => {
    const url = new URL(route.request().url());
    asked.push(url.searchParams.get("limit") ?? "");
    return route.fulfill({
      json: { devices: enrolled.slice(0, Number(url.searchParams.get("limit") ?? 20)), total: 931 },
    });
  });
  await page.goto("/");

  const card = page.locator("section[aria-labelledby='enrollments-title']");
  const rows = card.locator("ul > li");
  await expect(rows).toHaveCount(10);
  expect(asked).toContain("50");
  await expect(card.getByText("Showing 1–10 of 50 latest enrollments")).toBeVisible();

  await card.getByRole("button", { name: "Page 2" }).click();
  await expect(rows.first()).toContainText("NEW-PC-11");

  await card.getByRole("combobox", { name: "Rows per page" }).click();
  await page.getByRole("option", { name: "20 / page" }).click();
  await expect(rows).toHaveCount(20);
  await expect(rows.first()).toContainText("NEW-PC-01");

  await card.getByRole("combobox", { name: "Rows per page" }).click();
  await page.getByRole("option", { name: "50 / page" }).click();
  await expect(rows).toHaveCount(50);
  await expect(rows.last()).toContainText("NEW-PC-50");
});
