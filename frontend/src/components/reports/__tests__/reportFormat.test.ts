import { describe, expect, it } from "vitest";

import {
  columnWidth,
  formatCell,
  formatDuration,
  formatPeriod,
  formatSummaryValue,
  isRightAligned,
  toReportPeriod,
} from "../reportFormat";
import { kpiColumns } from "../ReportPreview";
import { needsLabel, orderCatalog } from "../ReportCatalog";
import type { ReportCatalogEntry } from "../../../api/reports";

describe("report cell formatting", () => {
  it("formats durations from seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(720)).toBe("12m");
    expect(formatDuration(3 * 3600 + 12 * 60)).toBe("3h 12m");
    expect(formatDuration(2 * 86400 + 4 * 3600 + 59)).toBe("2d 4h");
    expect(formatDuration(86400)).toBe("1d");
  });

  it("formats every column kind", () => {
    expect(formatCell(1234.5, "number")).toBe("1,234.5");
    expect(formatCell(97.25, "percent")).toBe("97.3%");
    expect(formatCell(100, "percent")).toBe("100%");
    expect(formatCell(99.95, "percent")).toBe("99.95%");
    expect(formatCell(99.999, "percent")).toBe("99.99%");
    expect(formatCell(0.01, "percent")).toBe("<0.1%");
    expect(formatCell(0, "percent")).toBe("0%");
    expect(formatCell(5400, "duration")).toBe("1h 30m");
    // A bare date is a calendar day; an instant is shown in Tirana time.
    expect(formatCell("2026-10-10", "date")).toBe("10 Oct 2026");
    expect(formatCell("2026-10-09T23:30:00Z", "date")).toBe("10 Oct 2026");
    expect(formatCell("2026-10-10T20:12:00Z", "datetime")).toBe("10 Oct 2026, 22:12");
    expect(formatCell("Compliant", "badge")).toBe("Compliant");
    expect(formatCell("NW-SRV-01", "text")).toBe("NW-SRV-01");
  });

  it("shows a dash for missing values and words for booleans", () => {
    for (const kind of ["text", "number", "percent", "date", "datetime", "duration", "badge"] as const) {
      expect(formatCell(null, kind)).toBe("—");
      expect(formatCell(undefined, kind)).toBe("—");
      expect(formatCell("", kind)).toBe("—");
    }
    expect(formatCell(true, "text")).toBe("Yes");
    expect(formatCell(false, "badge")).toBe("No");
    expect(formatCell("n/a", "number")).toBe("n/a");
  });

  it("aligns by the column's align, else numbers right", () => {
    expect(isRightAligned({ key: "a", label: "A", align: "right", kind: "text" })).toBe(true);
    expect(isRightAligned({ key: "a", label: "A", align: "left", kind: "number" })).toBe(false);
  });

  it("formats KPI values by their kind and keeps worded values", () => {
    expect(formatSummaryValue(12345)).toBe("12,345");
    expect(formatSummaryValue(12345, "number")).toBe("12,345");
    expect(formatSummaryValue(87.44, "percent")).toBe("87.4%");
    expect(formatSummaryValue(99.97, "percent")).toBe("99.97%");
    expect(formatSummaryValue(4 * 3600 + 12 * 60, "duration")).toBe("4h 12m");
    expect(formatSummaryValue("needs agent 2.1.31", "text")).toBe("needs agent 2.1.31");
    expect(formatSummaryValue("needs agent 2.1.31", "percent")).toBe("needs agent 2.1.31");
    expect(formatSummaryValue(null, "percent")).toBe("—");
  });

  it("shows objects and lists a cell might carry as text", () => {
    expect(formatCell(["C:", "D:"], "text")).toBe("C:, D:");
    expect(formatCell({ a: 1 }, "text")).toBe('{"a":1}');
  });

  it("sizes narrow columns for their header and badges for their longest chip", () => {
    const badge = { key: "status", label: "Status", align: "left" as const, kind: "badge" as const };
    expect(columnWidth(badge, [{ status: "OK" }])).toBe(136);
    expect(columnWidth(badge, [{ status: "Ends within 12 months" }])).toBeGreaterThan(190);
    expect(columnWidth({ key: "n", label: "#", align: "right", kind: "number" })).toBe(88);
    expect(columnWidth({ key: "d", label: "Missing updates", align: "right", kind: "number" })).toBe(160);
    expect(columnWidth({ key: "t", label: "Issue", align: "left", kind: "text" })).toBeUndefined();
  });
});

describe("report periods", () => {
  it("passes preset days and turns a custom range into whole Tirana days", () => {
    expect(toReportPeriod("30", "", "")).toEqual({ period_days: 30 });
    expect(toReportPeriod("custom", "2026-09-01", "2026-09-03")).toEqual({
      period_from: "2026-08-31T22:00:00.000Z",
      period_to: "2026-09-03T22:00:00.000Z",
    });
    expect(toReportPeriod("custom", "2026-09-03", "2026-09-01")).toBeNull();
    expect(toReportPeriod("custom", "2026-09-03", "")).toBeNull();
  });

  it("shows the last covered day of an exclusive end", () => {
    expect(formatPeriod("2026-08-31T22:00:00Z", "2026-09-30T22:00:00Z", true)).toBe("1 Sept 2026 – 30 Sept 2026");
  });
});

describe("catalog helpers", () => {
  const entry = (key: ReportCatalogEntry["key"]): ReportCatalogEntry => ({
    key,
    title: key,
    description: "",
    formats: ["pdf"],
    needs: null,
  });

  it("puts the executive report first and keeps the server order otherwise", () => {
    const keys = orderCatalog([entry("full"), entry("capacity"), entry("executive"), entry("lifecycle")]).map(
      (e) => e.key,
    );
    expect(keys).toEqual(["executive", "full", "capacity", "lifecycle"]);
  });

  it("words the needs note", () => {
    expect(needsLabel("agent 2.1.31")).toBe("Needs agent 2.1.31");
    expect(needsLabel("2.1.31")).toBe("Needs agent 2.1.31");
    expect(needsLabel("Needs agent 2.1.31")).toBe("Needs agent 2.1.31");
  });

  it("lays KPI tiles out in even rows", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(kpiColumns)).toEqual([1, 2, 3, 4, 5, 3, 4, 4, 3]);
  });
});
