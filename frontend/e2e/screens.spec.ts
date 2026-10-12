import { test } from "./test";

// Screenshots of the main pages in both themes, for reviewing a visual
// change by eye. Off by default: SCREENS=1 npx playwright test screens
// writes them to e2e/.screens/ (not committed).
test.skip(!process.env.SCREENS, "set SCREENS=1 to capture screenshots");
test.use({ reducedMotion: "reduce" });

const PAGES = ["/", "/devices", "/alerts", "/operators", "/settings", "/notifications", "/login"];

for (const theme of ["dark", "light"] as const) {
  for (const path of PAGES) {
    test(`${theme} ${path}`, async ({ page, api }, info) => {
      if (path === "/login") api.user = null;
      await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const name = `${info.project.name}-${theme}-${path === "/" ? "dashboard" : path.slice(1)}.png`;
      await page.screenshot({ path: `e2e/.screens/${name}`, fullPage: true });
    });
  }
}
