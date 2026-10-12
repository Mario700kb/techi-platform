import { expect, test } from "./test";

// Motion on (the default here); the global reduced-motion rule is covered by CSS.
test("the quick-filter row opens smoothly and its chips enter one after another", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "the quick-filter row is the desktop toolbar");
  await page.goto("/devices");
  const row = page.locator(".th-quick-filters");
  await expect(row).toHaveAttribute("data-open", "true");

  const chips = row.locator(".th-filter-chip");
  await expect(chips.first()).toBeVisible();
  const motion = await chips.evaluateAll((els) =>
    els.map((el) => {
      const style = getComputedStyle(el);
      return { name: style.animationName, delay: style.animationDelay };
    }),
  );
  expect(motion.every((m) => m.name === "th-chip-in")).toBe(true);
  // Staggered: each chip starts a little after the one before it.
  const delays = motion.map((m) => parseFloat(m.delay));
  expect(delays).toEqual([...delays].sort((a, b) => a - b));
  expect(new Set(delays).size).toBe(delays.length);

  // The row grows through its grid track rather than appearing at full height.
  const transition = await row.evaluate((el) => getComputedStyle(el).transitionProperty);
  expect(transition).toContain("grid-template-rows");
});
