import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

const PANELS = [
  "Alerts by type",
  "Security & risk",
  "Agent versions",
  "Clients",
  "Device categories",
  "Availability trend",
  "Alerts this week",
  "Problem devices",
  "Latest enrollments",
  "Who's online",
  "System status",
];

async function openDashboard(page: Page, width = 412) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await expect(page.locator(".th-mpanel-toggle")).toHaveCount(PANELS.length);
}

async function openEveryPanel(page: Page) {
  const toggles = page.locator(".th-mpanel-toggle");
  for (let i = 0; i < PANELS.length; i++) await toggles.nth(i).click();
  await expect(page.locator(".th-mpanel-body")).toHaveCount(PANELS.length);
}

test.describe("mobile dashboard", () => {
  test.skip(({ isMobile }) => !isMobile, "the phone layout");

  test("reads from the fleet's state down to what needs a decision", async ({ page }) => {
    await openDashboard(page);
    const top = (selector: string) =>
      page
        .locator(`.th-mdash ${selector}`)
        .first()
        .evaluate((el) => el.getBoundingClientRect().top);
    const order = [
      await top(".th-mpulse"),
      await top(".th-briefing"),
      await top(".th-mdash-kpis"),
      await top(".th-mscroll"),
      await top("#m-attention-title"),
      await top("#m-sla-title"),
      await top("#m-actions-title"),
      await top(".th-mpanels"),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    await expect(page.getByRole("img", { name: /% online —/ })).toBeVisible();
  });

  test("every desktop analysis is one tap away and renders only when opened", async ({ page }) => {
    await openDashboard(page);
    await expect(page.locator(".th-mpanel-title")).toHaveText(PANELS);
    await expect(page.locator(".th-mpanel-body")).toHaveCount(0);

    const risk = page.getByRole("button", { name: /Security & risk/ });
    await expect(risk).toHaveAttribute("aria-expanded", "false");
    await risk.click();
    await expect(risk).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".th-mpanel-body .th-risk-row").first()).toBeVisible();
    await risk.click();
    await expect(page.locator(".th-mpanel-body")).toHaveCount(0);

    await openEveryPanel(page);
    for (let i = 0; i < PANELS.length; i++) {
      await expect(page.locator(".th-mpanel-body").nth(i)).not.toBeEmpty();
    }
  });

  for (const width of [320, 360, 412]) {
    test(`fits a ${width}px phone, closed and with every panel open`, async ({ page }) => {
      await openDashboard(page, width);
      const overflow = () =>
        page.evaluate(() => {
          const main = document.querySelector("main")!;
          return main.scrollWidth - main.clientWidth + document.documentElement.scrollWidth - innerWidth;
        });
      expect(await overflow()).toBeLessThanOrEqual(0);
      await openEveryPanel(page);
      expect(await overflow()).toBeLessThanOrEqual(0);

      // Ring legends keep their whole label at every width.
      const cut = await page
        .locator(".th-mpanel-body .th-cp-legend button span")
        .evaluateAll((labels) =>
          labels.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent),
        );
      expect(cut).toEqual([]);

      const cutMeters = await page
        .locator(".th-mpanel-body .th-cp-meter-name > .truncate")
        .evaluateAll((labels) =>
          labels.filter((el) => el.scrollHeight > el.clientHeight + 1).map((el) => el.textContent),
        );
      expect(cutMeters).toEqual([]);
    });
  }

  test("every control is big enough for a finger", async ({ page }) => {
    await openDashboard(page);
    await openEveryPanel(page);
    const small = await page.locator(".th-mdash").evaluate((root) =>
      [...root.querySelectorAll("a, button")]
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => ({ text: el.textContent?.trim().slice(0, 30), height: el.getBoundingClientRect().height }))
        .filter((el) => el.height < 44),
    );
    expect(small).toEqual([]);
  });

  test("sideways lists scroll on their own, the page stays put", async ({ page }) => {
    await openDashboard(page);
    const scorecard = page.locator(".th-mdash .th-mscroll");
    await expect(scorecard.locator(".th-dscore")).toHaveCount(5);
    const moved = await scorecard.evaluate((el) => {
      el.scrollLeft = 200;
      return el.scrollLeft;
    });
    expect(moved).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollLeft)).toBe(0);
  });

  test("has no serious accessibility violations with every panel open", async ({ page }) => {
    await openDashboard(page);
    await openEveryPanel(page);
    await page.waitForLoadState("networkidle");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await new AxeBuilder({ page: page as any })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const serious = results.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
    expect(serious).toEqual([]);
  });

  test("the client filter narrows the phone view too", async ({ page }) => {
    await openDashboard(page);
    await page.getByRole("combobox", { name: "Show the dashboard for" }).click();
    await page.getByRole("option").nth(1).click();
    await expect(page).toHaveURL(/client=\d+/);
    await expect(page.locator(".th-mpanel-title").nth(3)).toHaveText("Groups");
  });
});
