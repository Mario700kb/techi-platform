import { DEVICES } from "./mockApi";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

test("a device's group can be any of the six standard groups, made on first use", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "the drawer is the desktop device view");
  let body: unknown = null;
  await page.route(/\/api\/v1\/devices\/1\/assign-group$/, async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({
      json: { ...DEVICES[0], group_id: 99, group_name: "Hypervisors", assignment_source: "manual" },
    });
  });
  await page.goto("/devices");
  await page.locator("tr", { hasText: "NW-RECEPTION-01" }).getByText("NW-RECEPTION-01").first().click();

  const picker = page.getByRole("combobox", { name: "Assign group" });
  await expect(picker).toContainText("Front desk");
  await picker.click();
  await expect(page.getByRole("option")).toHaveText([
    "No group",
    "Servers",
    "Client PC",
    "Network",
    "Storage",
    "Hypervisors",
    "Other",
    "Front desk",
  ]);
  await page.getByRole("option", { name: "Hypervisors" }).click();

  await expect.poll(() => body).toEqual({ group_name: "Hypervisors" });
  // The new group is not in the client's list yet; the picker shows it by name.
  await expect(picker).toContainText("Hypervisors");
});
