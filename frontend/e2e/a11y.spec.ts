import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./test";

// Serious and critical WCAG 2.1 A/AA violations fail the build; minor and
// moderate ones are reported in the trace without blocking.
async function seriousViolations(page: Page) {
  // @axe-core/playwright types a slightly older Page; the runtime object is the same.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder = new AxeBuilder({ page: page as any });
  const results = await builder.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .flatMap((v) =>
      v.nodes.map(
        (node) =>
          `${v.id} (${v.impact}) at ${node.target.join(" ")}: ${node.failureSummary?.split("\n")[1]?.trim() ?? v.help}`,
      ),
    );
}

// Entry animations fade text in; sampled mid-fade it reads as low contrast.
test.use({ reducedMotion: "reduce" });

for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    });

    test.describe("signed out", () => {
      test.use({ signedOut: true });
      test("sign-in page", async ({ page }) => {
        await page.goto("/login");
        await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
        expect(await seriousViolations(page)).toEqual([]);
      });
    });

    for (const path of ["/", "/devices", "/alerts", "/operators", "/settings"]) {
      test(`${path} has no serious accessibility violations`, async ({ page }) => {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        expect(await seriousViolations(page)).toEqual([]);
      });
    }
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme} device inventory tab has no serious accessibility violations`, async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "the drawer is the desktop device view");
    await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
    await page.goto("/devices");
    await page.locator("tr", { hasText: "NW-RECEPTION-01" }).getByText("NW-RECEPTION-01").first().click();
    await page.getByRole("tab", { name: /Software/ }).click();
    await page.getByRole("button", { name: "Load inventory" }).click();
    await page.getByRole("radio", { name: /Services/ }).click();
    await expect(page.locator(".th-inv-table tbody tr")).toHaveCount(4);
    expect(await seriousViolations(page)).toEqual([]);
  });
}
