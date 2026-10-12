import type { Page } from "@playwright/test";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

async function positions(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top) };
    };
    const aside = document.querySelector("aside.th-sidebar")!;
    return {
      icons: [...aside.querySelectorAll("nav a.th-nav-item svg")].map(box),
      avatar: box(aside.querySelector(".th-avatar")),
      logo: box(aside.querySelector("img")),
    };
  });
}

test("collapsing the sidebar moves no icon, the logo symbol or the avatar", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "the sidebar is the desktop layout");
  await page.addInitScript(() => localStorage.setItem("techi.sidebar.collapsed", "false"));
  await page.goto("/");
  // The menu gains items once platform features load; measure after that.
  await page.waitForLoadState("networkidle");
  const aside = page.locator("aside.th-sidebar");
  await expect(aside).toHaveAttribute("data-expanded", "true");
  const open = await positions(page);

  await aside.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(aside).toHaveAttribute("data-expanded", "false");
  await expect.poll(async () => (await aside.boundingBox())?.width).toBe(64);
  const closed = await positions(page);

  expect(closed.icons.length).toBeGreaterThan(5);
  expect(closed.icons).toEqual(open.icons);
  expect(closed.avatar).toEqual(open.avatar);
  expect(closed.logo).toEqual(open.logo);
  expect(open.icons[0]!.x).toBe(24);
});
