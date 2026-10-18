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
  // Newest resolved first: the three shown end with the first offline…
  await expect(section.getByText("Device offline")).toHaveCount(1);
  await expect(section.getByText("Remote Support sync failed")).toHaveCount(0);
  await expect(section.getByText("Repeated reconnects")).toHaveCount(0);
  // …and the four older ones are one click away.
  await section.getByRole("button", { name: "Show 4 more" }).click();
  await expect(section.getByText("Remote Support sync failed")).toBeVisible();
  await expect(section.getByText("Repeated reconnects")).toBeVisible();
  await expect(section.getByText("Device offline")).toHaveCount(2);
});
