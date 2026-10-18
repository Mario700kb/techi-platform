import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { mockReports } from "./reportsMocks";
import { expect, test } from "./test";

test.use({ reducedMotion: "reduce" });

/** Screenshots go to REPORTS_SHOTS_DIR when set (for review), else the test's output folder. */
function shotPath(name: string): string {
  const dir = process.env.REPORTS_SHOTS_DIR;
  if (!dir) return test.info().outputPath(name);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

/** No sideways scroll on the page itself (tables scroll inside their frame). */
async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const main = document.querySelector(".th-main");
    const doc = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    return Math.max(doc, main ? main.scrollWidth - main.clientWidth : 0);
  });
  expect(overflow).toBeLessThan(2);
}

async function boxes(locator: Locator) {
  return locator.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }),
  );
}

const last = <T>(items: T[]): T | undefined => items[items.length - 1];
const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

/** The app scrolls inside its main pane, so screenshots use a viewport tall enough for the whole page. */
async function tallShots(page: Page, preview: string, whole?: string) {
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width, height: 2600 });
  await page.evaluate(() => document.querySelector(".th-main")?.scrollTo(0, 0));
  await page.locator(".th-rpt-preview-card").screenshot({ path: shotPath(preview) });
  if (whole) await page.screenshot({ path: shotPath(whole) });
  await page.setViewportSize(size);
}

async function openReports(page: Page) {
  const api = await mockReports(page);
  await page.goto("/reports");
  await expect(page.getByRole("group", { name: "Report catalog" }).getByRole("button")).toHaveCount(8);
  await expect(page.getByRole("heading", { name: "Executive summary", level: 2 })).toBeVisible();
  return api;
}

test.describe("desktop", () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== "desktop", "the phone layout has its own test");
  });

  for (const theme of ["dark", "light"] as const) {
    test(`${theme}: the catalog is an even grid and the preview renders executive and lifecycle`, async ({ page }) => {
      await page.addInitScript((value) => window.localStorage.setItem("techi.theme", value), theme);
      const api = await openReports(page);

      // ── catalog: eight equal cards, four to a row, executive first ──
      const cards = page.getByRole("group", { name: "Report catalog" }).getByRole("button");
      await expect(cards.first()).toHaveAttribute("data-report", "executive");
      await expect(cards.first()).toContainText("Recommended");
      await expect(cards.first()).toHaveAttribute("aria-pressed", "true");
      await expect(cards.filter({ hasText: "Security posture" })).toContainText("Needs agent 2.1.31");
      const cardBoxes = await boxes(cards);
      expect(spread(cardBoxes.map((b) => b.h))).toBeLessThan(1.5);
      expect(spread(cardBoxes.map((b) => b.w))).toBeLessThan(1.5);
      expect(spread(cardBoxes.slice(0, 4).map((b) => b.y))).toBeLessThan(1);
      expect(spread(cardBoxes.slice(4).map((b) => b.y))).toBeLessThan(1);

      // ── executive preview ──
      expect(last(api.previews)?.searchParams.get("report_type")).toBe("executive");
      expect(last(api.previews)?.searchParams.get("client_id")).toBe("1");
      expect(last(api.previews)?.searchParams.get("period_days")).toBe("30");
      const doc = page.getByRole("article", { name: "Executive summary preview" });
      const kpis = doc.locator(".th-rpt-kpi");
      await expect(kpis).toHaveCount(6);
      // Six equal tiles in two even rows of three.
      const kpiBoxes = await boxes(kpis);
      expect(spread(kpiBoxes.map((b) => b.w))).toBeLessThan(1.5);
      expect(spread(kpiBoxes.map((b) => b.h))).toBeLessThan(1.5);
      expect(spread(kpiBoxes.slice(0, 3).map((b) => b.y))).toBeLessThan(1);
      expect(spread(kpiBoxes.slice(3).map((b) => b.y))).toBeLessThan(1);
      await expect(kpis.filter({ hasText: "Unsupported OS" })).toHaveAttribute("data-tone", "crit");
      await expect(kpis.filter({ hasText: "Patch compliance" })).toContainText("87.5%");
      await expect(kpis.filter({ hasText: "Server availability" })).toContainText("99.95%");
      const worded = kpis.filter({ hasText: "Security: protected" }).locator(".th-rpt-kpi-value");
      await expect(worded).toHaveText("needs agent 2.1.31");
      expect(await worded.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

      const issues = doc.getByRole("region", { name: "Top issues" });
      await expect(issues.locator("tbody tr")).toHaveCount(4);
      const chip = issues.locator("tbody tr").first().locator(".th-status-chip");
      await expect(chip).toHaveText("Critical");
      const [chipDot, critical] = await chip.evaluate((el) => [
        getComputedStyle(el.querySelector("i")!).backgroundColor,
        getComputedStyle(document.documentElement).getPropertyValue("--th-status-critical").trim(),
      ]);
      expect(chipDot).toBe(
        await page.evaluate((hex) => {
          const probe = document.createElement("span");
          probe.style.color = hex;
          document.body.appendChild(probe);
          const rgb = getComputedStyle(probe).color;
          probe.remove();
          return rgb;
        }, critical),
      );
      // Long text wraps instead of being cut.
      const recommendation = doc
        .getByRole("region", { name: "Recommendations" })
        .locator("tbody tr")
        .first()
        .locator("td")
        .nth(1);
      await expect(recommendation).toContainText("largest risk in this fleet.");
      expect(
        await recommendation.locator("span").evaluate((el) => ({
          wraps: getComputedStyle(el).whiteSpace === "normal",
          clipped: el.scrollWidth > el.clientWidth,
        })),
      ).toEqual({ wraps: true, clipped: false });
      // Right-aligned columns, header and cells alike.
      const align = (loc: Locator) => loc.evaluate((el) => getComputedStyle(el).textAlign);
      const areas = doc.getByRole("region", { name: "Areas" });
      expect(await align(areas.getByRole("columnheader", { name: "Value" }))).toBe("right");
      expect(await align(areas.getByRole("row").nth(1).getByRole("cell").nth(2))).toBe("right");
      expect(await align(areas.getByRole("columnheader", { name: "Measure" }))).toBe("left");
      await expect(areas.locator("tbody tr").nth(2).locator(".th-status-chip")).toHaveText("Action needed");
      await expect(doc.getByText("Each area has its own detailed report")).toBeVisible();
      await expectNoHorizontalScroll(page);
      await tallShots(page, `reports-executive-${theme}.png`, `reports-page-${theme}.png`);

      // ── lifecycle preview ──
      await cards.filter({ hasText: "OS lifecycle & hardware" }).click();
      const lifecycle = page.getByRole("article", { name: "OS lifecycle & hardware preview" });
      await expect(lifecycle).toBeVisible();
      await expect(lifecycle.locator(".th-rpt-kpi")).toHaveCount(4);
      await expect(lifecycle.locator(".th-rpt-kpi").filter({ hasText: "Supported" }).last()).toContainText("93.5%");
      const unsupported = lifecycle.getByRole("region", { name: "Unsupported OS" });
      await expect(unsupported.locator("tbody tr")).toHaveCount(3);
      const doctor = unsupported.getByRole("row", { name: /^Open NW-DOCTOR-02/ });
      await expect(doctor).toContainText("14 Oct 2025");
      await expect(doctor).toContainText("368");
      expect(await align(unsupported.getByRole("columnheader", { name: "Days since" }))).toBe("right");
      // A row without a device id is not a link.
      await expect(unsupported.locator("tbody tr").nth(2)).not.toHaveAttribute("tabindex", "0");
      // Only listed columns: the extra disk_free_gb (17.6) never shows.
      const hardware = lifecycle.getByRole("region", { name: "Low memory or disk space" });
      await expect(hardware).toContainText("7.4%");
      await expect(hardware).not.toContainText("17.6");
      await expect(hardware.locator("tbody tr").nth(1)).toContainText("—");
      // A long badge fits its column.
      const overview = lifecycle.getByRole("region", { name: "OS overview" });
      const longChip = overview.locator(".th-status-chip", { hasText: "Ends within 12 months" });
      const chipBox = (await longChip.boundingBox())!;
      const cellBox = (await longChip.locator("xpath=..").boundingBox())!;
      expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(cellBox.x + cellBox.width + 0.5);
      await expect(lifecycle.getByText("RAM from 7.5 GB counts as 8 GB")).toBeVisible();
      await expect(page.getByRole("button", { name: "Download CSV" })).toBeEnabled();
      await expectNoHorizontalScroll(page);
      await tallShots(page, `reports-lifecycle-${theme}.png`);
    });
  }

  test("Download PDF generates the chosen report, then downloads that run", async ({ page }) => {
    const api = await openReports(page);
    await page.getByRole("radio", { name: "90 days" }).click();
    await expect.poll(() => last(api.previews)?.searchParams.get("period_days")).toBe("90");
    await expect(page.getByRole("button", { name: "Download CSV" })).toBeDisabled();

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PDF" }).click();
    expect((await download).suggestedFilename()).toBe("northwind-executive.pdf");
    expect(api.generated).toEqual([
      { scope_type: "client", client_id: 1, report_type: "executive", report_format: "pdf", period_days: 90 },
    ]);
    expect(api.downloads).toEqual([200]);
    await expect(page.getByRole("status")).toContainText("Executive summary PDF for Northwind Clinic is ready.");

    // The run is listed with the others.
    await page.getByRole("tab", { name: /Runs/ }).click();
    await expect(page.getByRole("tab", { name: /Runs/ })).toContainText("3");
    await expect(page.locator("#rpt-panel-runs tbody tr").first()).toContainText("Executive summary");
  });

  test("a device row in the preview opens that device's drawer", async ({ page }) => {
    await openReports(page);
    await page
      .getByRole("group", { name: "Report catalog" })
      .getByRole("button", { name: /OS lifecycle/ })
      .click();
    await page
      .getByRole("region", { name: "Unsupported OS" })
      .getByRole("row", { name: /^Open NW-DOCTOR-02/ })
      .click();
    // The Devices page opens the drawer from ?device= and then drops the parameter.
    await expect(page.locator(".th-drawer-panel").getByRole("heading", { name: "NW-DOCTOR-02" })).toBeVisible();
    await expect(page).toHaveURL(/\/devices/);
  });

  test("the full fleet report has no preview but downloads", async ({ page }) => {
    const api = await openReports(page);
    const asked = api.previews.length;
    const full = page.getByRole("group", { name: "Report catalog" }).getByRole("button", { name: /Full fleet report/ });
    await expect(full).toContainText("File only");
    await full.click();
    await expect(page.getByText("Full fleet report has no on-screen preview")).toBeVisible();
    expect(api.previews.length).toBe(asked);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download CSV" }).click();
    expect((await download).suggestedFilename()).toBe("northwind-full.csv");
    expect(last(api.generated)).toMatchObject({ report_type: "full", report_format: "csv", client_id: 1 });
  });

  test("Schedule… opens the schedule form with the report preselected; schedules show their report", async ({
    page,
  }) => {
    await openReports(page);
    await page
      .getByRole("group", { name: "Report catalog" })
      .getByRole("button", { name: /OS lifecycle/ })
      .click();
    await page.getByRole("button", { name: "Schedule…" }).click();
    const dialog = page.getByRole("dialog", { name: "New report schedule" });
    await expect(dialog.getByRole("combobox", { name: "Report" })).toContainText("OS lifecycle & hardware");
    await expect(dialog.getByRole("combobox", { name: "Client" })).toContainText("Northwind Clinic");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("tab", { name: /Schedules/ }).click();
    const row = page.getByRole("table", { name: "Report schedules" }).getByRole("row", { name: /Northwind monthly/ });
    await expect(row).toContainText("Executive summary");
    await expect(row).toContainText("Monthly · day 1 · 08:00");
  });

  test("device reports and runs keep working in their tabs", async ({ page }) => {
    await openReports(page);
    await page.getByRole("tab", { name: /Device reports/ }).click();
    await expect(page.getByRole("combobox", { name: "Report type" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate" })).toBeVisible();
    await expect(page.locator("#rpt-panel-device").getByText("BH-WH-SCANNER", { exact: true })).toBeVisible();
    // Device report form and recent list stand side by side, equal height.
    const pair = await boxes(page.locator("#rpt-panel-device .th-onb-card"));
    expect(pair).toHaveLength(2);
    expect(Math.abs(pair[0].h - pair[1].h)).toBeLessThan(1.5);
    expect(Math.abs(pair[0].y - pair[1].y)).toBeLessThan(1);

    await page.getByRole("tab", { name: /Runs/ }).click();
    await expect(page.locator("#rpt-panel-runs tbody tr")).toHaveCount(2);
    await expect(page.locator("#rpt-panel-runs tbody tr").first()).toContainText("Full fleet report");
    await expect(page.locator("#rpt-panel-runs tbody tr").nth(1)).toContainText("Alerts");
  });

  test("print shows only the report", async ({ page }) => {
    await openReports(page);
    await page.emulateMedia({ media: "print" });
    await expect(page.getByRole("article", { name: "Executive summary preview" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Report catalog" })).toBeHidden();
    await expect(page.getByRole("toolbar", { name: "Report options" })).toBeHidden();
    await expect(page.locator("aside, nav").first()).toBeHidden();
    await page.screenshot({ path: shotPath("reports-print.png"), fullPage: true });
  });

  for (const [width, height] of [
    [390, 844],
    [1280, 720],
    [1440, 900],
  ] as const) {
    test(`${width}×${height}: no page overflow, tables scroll inside their card`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openReports(page);
      const cardBoxes = await boxes(page.getByRole("group", { name: "Report catalog" }).getByRole("button"));
      expect(spread(cardBoxes.map((b) => b.h))).toBeLessThan(1.5);
      expect(spread(cardBoxes.map((b) => b.w))).toBeLessThan(1.5);
      await expectNoHorizontalScroll(page);

      await page
        .getByRole("group", { name: "Report catalog" })
        .getByRole("button", { name: /OS lifecycle/ })
        .click();
      await expect(page.getByRole("article", { name: "OS lifecycle & hardware preview" })).toBeVisible();
      await expectNoHorizontalScroll(page);
      // Every table frame stays inside the preview card.
      const card = (await page.locator(".th-rpt-preview-card").boundingBox())!;
      for (const frame of await boxes(page.locator(".th-rpt-table-wrap"))) {
        expect(frame.x).toBeGreaterThanOrEqual(card.x - 0.5);
        expect(frame.x + frame.w).toBeLessThanOrEqual(card.x + card.width + 0.5);
      }
      if (width === 390) {
        const scrolls = await page
          .locator(".th-rpt-table-wrap")
          .first()
          .evaluate((el) => el.scrollWidth > el.clientWidth);
        expect(scrolls).toBe(true);
        await tallShots(page, "reports-mobile-390-preview.png", "reports-mobile-390.png");
      }
    });
  }
});

test("phone: catalog and preview fit the screen", async ({ page }) => {
  test.skip(test.info().project.name !== "mobile", "desktop has its own tests");
  await openReports(page);
  const cardBoxes = await boxes(page.getByRole("group", { name: "Report catalog" }).getByRole("button"));
  expect(spread(cardBoxes.map((b) => b.h))).toBeLessThan(1.5);
  await expect(page.locator(".th-rpt-kpi")).toHaveCount(6);
  await expectNoHorizontalScroll(page);
});
