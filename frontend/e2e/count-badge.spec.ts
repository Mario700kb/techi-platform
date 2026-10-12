import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: the critical alert badge has white text`, async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "the top-bar bell is desktop only");
    await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    await page.goto("/");
    // The mock fleet has a critical alert, so the badge uses the critical tone.
    const badge = page.locator('.th-count-badge[data-tone="critical"]').first();
    await expect(badge).toBeVisible();
    await expect(badge).toHaveCSS("color", "rgb(255, 255, 255)");
  });
}
