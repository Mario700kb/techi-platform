import type { Locator } from "@playwright/test";

import { northwindProfile } from "./profileMocks";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

/** For each column: how far the heading sits from what its cells show, on the
 *  side the heading is aligned to (left, or right for number columns). */
async function columnOffsets(table: Locator) {
  return table.evaluate((el) => {
    // Hidden until hover, or not drawn at all: not part of the line the eye follows.
    const hidden = (node: Element) => {
      for (let n: Element | null = node; n; n = n.parentElement) {
        const style = getComputedStyle(n);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return true;
      }
      return false;
    };
    // Text, and elements that draw something (a badge's fill or border, a
    // button, a dot, an icon). Layout wrappers span the cell whatever is
    // inside, so they do not count.
    const draws = (node: Element) => {
      const style = getComputedStyle(node);
      const filled = style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent";
      const bordered = parseFloat(style.borderLeftWidth) > 0 && !style.borderLeftColor.endsWith(", 0)");
      // A ghost icon button draws only its glyph (the svg) until hover.
      return filled || bordered || ["svg", "img", "input"].includes(node.tagName.toLowerCase());
    };
    const rectsOf = (root: Element) => {
      const rects: DOMRect[] = [];
      for (const node of root.querySelectorAll("*")) {
        if (!draws(node) || hidden(node)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width > 0) rects.push(rect);
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent?.trim() || !text.parentElement || hidden(text.parentElement)) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        rects.push(...[...range.getClientRects()].filter((r) => r.width > 0));
      }
      return rects;
    };
    const heads = [...el.querySelectorAll("thead th")];
    // The first real row: one cell per heading (day and group headers span the table).
    const row = [...el.querySelectorAll("tbody tr")].find((tr) => tr.querySelectorAll("td").length === heads.length);
    const cells = row ? [...row.querySelectorAll("td")] : [];
    return heads.flatMap((th, i) => {
      const heading = rectsOf(th);
      const content = cells[i] ? rectsOf(cells[i]) : [];
      if (!heading.length || !content.length) return [];
      const right = getComputedStyle(th).textAlign === "right" || getComputedStyle(th).textAlign === "end";
      const delta = right
        ? Math.max(...content.map((r) => r.right)) - Math.max(...heading.map((r) => r.right))
        : Math.min(...content.map((r) => r.left)) - Math.min(...heading.map((r) => r.left));
      return [
        {
          heading: (th.textContent ?? "").trim() || "(select)",
          side: right ? "right" : "left",
          delta: Math.round(delta),
        },
      ];
    });
  });
}

async function expectAligned(table: Locator) {
  // Wait for real rows (loading skeletons span the table).
  await expect
    .poll(async () => (await columnOffsets(table)).length, { message: "no column was measured" })
    .toBeGreaterThan(2);
  const offsets = await columnOffsets(table);
  const off = offsets.filter((o) => Math.abs(o.delta) > 2);
  expect(off, `columns off their content: ${JSON.stringify(off)}`).toEqual([]);
}

test.beforeEach(() => {
  test.skip(test.info().project.name !== "desktop", "phones show cards, not tables");
});

// Every column heading starts where its column's content starts — text,
// badge, status dot or button — so each table reads in straight lines.
test("Devices", async ({ page }) => {
  await page.goto("/devices");
  await expectAligned(page.locator("table").filter({ has: page.getByRole("columnheader", { name: /Actions/ }) }));
});

for (const tab of ["Devices", "Alerts", "Activity", "Analytics"]) {
  test(`Client profile · ${tab}`, async ({ page }) => {
    await northwindProfile(page);
    await page.goto("/clients/1");
    await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
    const table = page.getByRole("tabpanel").locator("table:has(thead)").first();
    await expectAligned(table);
  });
}

for (const path of ["/alerts", "/clients", "/operators", "/teams", "/audit"]) {
  test(`page ${path}`, async ({ page }) => {
    await page.goto(path);
    const table = page.locator("main table:has(thead), section table:has(thead)").first();
    await expectAligned(table);
  });
}
