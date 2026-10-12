import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

test("the drawer lists every kind of resolved alert, newest resolved first", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "the drawer is the desktop device view");
  await page.goto("/devices");
  await page.locator("tr", { hasText: "NW-DOCTOR-02" }).getByText("NW-DOCTOR-02").first().click();

  const section = page
    .locator("div")
    .filter({ has: page.getByText("Recently resolved", { exact: true }) })
    .last();
  await expect(section.getByText("Recently resolved")).toBeVisible();
  // Kinds, not just severities, and warnings as well as critical ones.
  await expect(section.getByText("High CPU")).toBeVisible();
  await expect(section.getByText("Low disk space")).toBeVisible();
  await expect(section.getByText("warning").first()).toBeVisible();
  // Newest resolved first: the five shown end with the sync failure…
  await expect(section.getByText("Remote Support sync failed")).toBeVisible();
  await expect(section.getByText("Repeated reconnects")).toHaveCount(0);
  // …and the two older ones are one click away.
  await section.getByRole("button", { name: "Show 2 more" }).click();
  await expect(section.getByText("Repeated reconnects")).toBeVisible();
  await expect(section.getByText("Device offline")).toHaveCount(2);
});
