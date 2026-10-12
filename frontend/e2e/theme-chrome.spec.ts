import { expect, test } from "./test";

// The installed app's title bar (and the mobile status bar) takes
// <meta name="theme-color">: it must match the top bar, not brand orange.
for (const [theme, colour] of [
  ["dark", "#131316"],
  ["light", "#ffffff"],
] as const) {
  test(`${theme}: the window chrome matches the app's top bar`, async ({ page }) => {
    await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    await page.goto("/");
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", colour);
  });
}

test("the manifest no longer paints the title bar orange", async ({ request }) => {
  const manifest = await (await request.get("/manifest.json")).json();
  expect(manifest.theme_color).toBe("#131316");
});
