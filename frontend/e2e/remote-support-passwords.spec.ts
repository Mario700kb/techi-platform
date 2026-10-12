import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

test("an owner sees the password policy and can rotate every password", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "settings card layout is checked on desktop");
  await page.goto("/settings");
  const card = page.locator(".th-onb-card", { hasText: "Remote Support passwords" });
  await expect(card).toContainText("Every 30 days, at night");
  await expect(card).toContainText("4 devices");
  await expect(card).toContainText("1 device — their agent is too old");
  if (process.env.SCREENS) await card.screenshot({ path: "e2e/.screens/rs-passwords-card.png" });

  await card.getByRole("button", { name: "Rotate all now" }).click();
  const dialog = page.getByRole("dialog", { name: "Rotate every Remote Support password?" });
  await expect(dialog).toContainText("Connect from the console keeps working");
  await dialog.getByRole("button", { name: /Rotate 4 passwords/ }).click();
  await expect(dialog).toBeHidden();
  await expect(card).toContainText("New passwords for 4 devices");
});
