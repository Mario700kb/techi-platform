import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: the audit filters use the app's own calendar`, async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "desktop filter bar");
    await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    await page.goto("/audit");
    await expect(page.locator('input[type="date"], input[type="datetime-local"]')).toHaveCount(0);

    await page.getByRole("button", { name: /^From/ }).click();
    const dialog = page.getByRole("dialog", { name: "Choose date and time" });
    await expect(dialog).toBeVisible();
    if (process.env.SCREENS) await page.screenshot({ path: `e2e/.screens/datepicker-${theme}.png` });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await new AxeBuilder({ page: page as any })
      .include(".th-datepicker")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

    await dialog
      .getByRole("button", { name: /, 5 October 2026$|, 5 [A-Z][a-z]+ \d{4}$/ })
      .first()
      .click();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: /^From/ })).toContainText(", 00:00");
  });
}
