import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

// Every column heading starts where its column's content starts — text,
// badge, status dot or button — so the table reads in straight lines.
test("each Devices column heading lines up with its content", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "phones show cards, not the table");
  await page.goto("/devices");
  const table = page.locator("table").filter({ has: page.getByRole("columnheader", { name: /Actions/ }) });
  await expect(table.locator("tbody tr").first()).toBeVisible();

  const offsets = await table.evaluate((el) => {
    // The left edge of what the eye sees in a cell: text, and elements that
    // draw something (a badge's fill or border, a button, a dot, an icon).
    // Layout wrappers start at the cell padding whatever is inside, so they
    // do not count; neither does anything hidden until hover.
    const hidden = (node: Element) => {
      for (let n: Element | null = node; n; n = n.parentElement) {
        const style = getComputedStyle(n);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return true;
      }
      return false;
    };
    const draws = (node: Element) => {
      const style = getComputedStyle(node);
      const filled = style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent";
      const bordered = parseFloat(style.borderLeftWidth) > 0 && !style.borderLeftColor.endsWith(", 0)");
      return filled || bordered || ["svg", "img", "input", "button"].includes(node.tagName.toLowerCase());
    };
    const visibleLeft = (root: Element) => {
      let left = Infinity;
      for (const node of root.querySelectorAll("*")) {
        if (!draws(node) || hidden(node)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width > 0) left = Math.min(left, rect.left);
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent?.trim() || !text.parentElement || hidden(text.parentElement)) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        for (const rect of range.getClientRects()) if (rect.width > 0) left = Math.min(left, rect.left);
      }
      return left;
    };
    const headingLeft = (th: Element) => {
      const input = th.querySelector("input");
      if (input) return input.getBoundingClientRect().left;
      const range = document.createRange();
      range.selectNodeContents(th);
      return Math.min(...[...range.getClientRects()].filter((r) => r.width > 0).map((r) => r.left));
    };
    const heads = [...el.querySelectorAll("thead th")];
    const cells = [...el.querySelectorAll("tbody tr:first-child td")];
    return heads.map((th, i) => ({
      heading: (th.textContent ?? "").trim() || "(select)",
      delta: Math.round(visibleLeft(cells[i]) - headingLeft(th)),
    }));
  });

  for (const { heading, delta } of offsets) {
    expect(Math.abs(delta), `${heading} is ${delta}px off its content`).toBeLessThanOrEqual(2);
  }
  await table.screenshot({ path: test.info().outputPath("table-alignment.png") });
});
