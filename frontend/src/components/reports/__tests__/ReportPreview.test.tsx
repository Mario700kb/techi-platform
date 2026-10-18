import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ReportPreview from "../ReportPreview";
import ReportCatalog from "../ReportCatalog";
import type { ReportCatalogEntry, ReportDocument } from "../../../api/reports";

const DOC: ReportDocument = {
  key: "lifecycle",
  title: "Hardware lifecycle",
  subtitle: "Age, warranty and OS support of every device",
  client_id: 1,
  client_name: "Northwind Clinic",
  period_start: "2026-09-16T22:00:00Z",
  period_end: "2026-10-16T22:00:00Z",
  generated_at: "2026-10-17T08:05:00Z",
  summary: [
    { label: "Devices", value: 1042, kind: "number", hint: "Reporting in the period", tone: "info" },
    { label: "Past warranty", value: 7, hint: "Replace or extend", tone: "crit" },
    { label: "Security: protected", value: "needs agent 2.1.31", kind: "text", hint: null, tone: "warn" },
    { label: "Supported", value: 95.24, kind: "percent", hint: "40 of 42", tone: "ok" },
  ],
  sections: [
    {
      key: "devices",
      title: "Devices",
      description: "Every kind of column",
      columns: [
        { key: "name", label: "Device", align: "left", kind: "text" },
        { key: "count", label: "Patches", align: "right", kind: "number" },
        { key: "share", label: "Uptime", align: "right", kind: "percent" },
        { key: "bought", label: "Purchased", align: "left", kind: "date" },
        { key: "seen", label: "Last seen", align: "left", kind: "datetime" },
        { key: "down", label: "Downtime", align: "right", kind: "duration" },
        { key: "state", label: "State", align: "left", kind: "badge" },
      ],
      rows: [
        {
          name: "NW-SRV-01",
          count: 1204,
          share: 99.95,
          bought: "2019-03-14",
          seen: "2026-10-16T20:12:00Z",
          down: 3 * 3600 + 5 * 60,
          state: "Out of warranty",
          // Keys no column lists are not shown.
          serial: "SN-HIDDEN-1",
          _tone: "crit",
          _device_id: 3,
        },
        {
          name: "NW-RECEPTION-01",
          count: 12,
          share: 100,
          bought: null,
          seen: null,
          down: 0,
          state: "Supported",
          _tone: "ok",
        },
      ],
      empty: "No devices",
      note: "Warranty dates come from the vendor lookup.",
    },
    {
      key: "retired",
      title: "Retired this period",
      description: null,
      columns: [{ key: "name", label: "Device", align: "left", kind: "text" }],
      rows: [],
      empty: "No device was retired in this period.",
    },
  ],
  notes: ["Ages are counted from the purchase date.", "Unknown dates are shown as a dash."],
};

describe("ReportPreview", () => {
  it("renders header, toned KPI tiles, every column kind, empty texts and notes", () => {
    const onOpen = vi.fn();
    render(<ReportPreview document={DOC} onOpenDevice={onOpen} />);

    expect(screen.getByRole("heading", { name: "Hardware lifecycle" })).toBeInTheDocument();
    expect(screen.getByText("Northwind Clinic")).toBeInTheDocument();
    expect(screen.getByText("17 Sept 2026 – 16 Oct 2026")).toBeInTheDocument();
    expect(screen.getByText("17 Oct 2026, 10:05")).toBeInTheDocument();

    const tiles = document.querySelectorAll(".th-rpt-kpi");
    expect(tiles).toHaveLength(4);
    expect(tiles[1]).toHaveAttribute("data-tone", "crit");
    expect((tiles[1] as HTMLElement).style.getPropertyValue("--kpi-tone")).toBe("var(--th-status-critical)");
    expect((tiles[3] as HTMLElement).style.getPropertyValue("--kpi-tone")).toBe("var(--th-status-online)");
    expect(tiles[0]).toHaveTextContent("1,042");
    expect(tiles[3]).toHaveTextContent("95.2%");
    // A worded value is shown as written, set smaller.
    const worded = tiles[2].querySelector(".th-rpt-kpi-value")!;
    expect(worded).toHaveTextContent("needs agent 2.1.31");
    expect(worded).toHaveAttribute("data-text", "true");
    expect(tiles[0].querySelector(".th-rpt-kpi-value")).not.toHaveAttribute("data-text");
    expect(screen.queryByText("SN-HIDDEN-1")).not.toBeInTheDocument();
    expect(document.querySelector(".th-rpt-kpis")).toHaveStyle({ "--kpi-cols": "4" });

    const table = within(screen.getByRole("region", { name: "Devices" })).getByRole("table");
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((h) => h.className)).toEqual(["", "text-right", "text-right", "", "", "text-right", ""]);

    const server = within(table).getByRole("row", { name: /^Open NW-SRV-01/ });
    const cells = within(server).getAllByRole("cell");
    expect(cells.map((c) => c.textContent)).toEqual([
      "NW-SRV-01",
      "1,204",
      "99.95%",
      "14 Mar 2019",
      "16 Oct 2026, 22:12",
      "3h 5m",
      "Out of warranty",
    ]);
    expect(cells[1]).toHaveClass("text-right");
    expect(cells[5]).toHaveClass("text-right");
    const badge = within(cells[6]).getByText("Out of warranty").closest<HTMLElement>(".th-status-chip")!;
    expect(badge).toHaveClass("th-status-chip");
    expect(badge.style.getPropertyValue("--chip-tone")).toBe("var(--th-status-critical)");
    // The tone is carried by the badge; rows have no coloured side bar.
    expect(server).toHaveAttribute("data-tone", "crit");
    expect(server.style.getPropertyValue("--row-tone")).toBe("");

    const reception = within(table).getAllByRole("row")[2];
    expect(reception).not.toHaveAttribute("tabindex");
    expect(
      within(reception)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["NW-RECEPTION-01", "12", "100%", "—", "—", "0s", "Supported"]);
    expect(
      within(reception)
        .getByText("Supported")
        .closest<HTMLElement>(".th-status-chip")!
        .style.getPropertyValue("--chip-tone"),
    ).toBe("var(--th-status-online)");

    // A device row opens the device, by click and by keyboard.
    fireEvent.click(server);
    fireEvent.keyDown(server, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledWith(3);

    expect(screen.getByText("Warranty dates come from the vendor lookup.")).toBeInTheDocument();
    expect(screen.getByText("No device was retired in this period.")).toBeInTheDocument();
    expect(screen.getByText("Ages are counted from the purchase date.")).toBeInTheDocument();
    expect(screen.getByText("2 rows")).toBeInTheDocument();
  });
});

const CATALOG: ReportCatalogEntry[] = [
  { key: "full", title: "Full report", description: "Everything", formats: ["pdf", "csv"], needs: null },
  {
    key: "patch_compliance",
    title: "Patch compliance",
    description: "Missing updates by device",
    formats: ["pdf", "csv"],
    needs: null,
  },
  {
    key: "executive",
    title: "Executive summary",
    description: "One page for the client's management",
    formats: ["pdf"],
    needs: null,
  },
  {
    key: "security_posture",
    title: "Security posture",
    description: "Defender, firewall, BitLocker",
    formats: ["pdf", "csv"],
    needs: "agent 2.1.31",
  },
];

describe("ReportCatalog", () => {
  it("shows one card per report, executive first and highlighted, with formats and needs", () => {
    const onSelect = vi.fn();
    render(
      <ReportCatalog
        entries={CATALOG}
        selected="executive"
        onSelect={onSelect}
        loading={false}
        error={null}
        onRetry={vi.fn()}
      />,
    );
    const grid = screen.getByRole("group", { name: "Report catalog" });
    const cards = within(grid).getAllByRole("button");
    expect(cards).toHaveLength(4);
    expect(cards[0]).toHaveTextContent("Executive summary");
    expect(cards[0]).toHaveAttribute("data-featured", "true");
    expect(cards[0]).toHaveTextContent("Recommended");
    expect(cards[0]).toHaveAttribute("aria-pressed", "true");
    expect(cards[1]).toHaveAttribute("aria-pressed", "false");
    // Formats: PDF only for the executive summary.
    expect(cards[0].querySelector('.th-rpt-format[data-on="true"]')).toHaveTextContent("PDF");
    expect(cards[0].querySelectorAll(".th-rpt-format[data-on]")).toHaveLength(1);
    expect(cards[3]).toHaveTextContent("Needs agent 2.1.31");
    expect(cards[1]).not.toHaveTextContent("Needs");

    fireEvent.click(cards[3]);
    expect(onSelect).toHaveBeenCalledWith("security_posture");
  });

  it("shows skeleton cards while loading and a retry on error", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <ReportCatalog entries={[]} selected={null} onSelect={vi.fn()} loading error={null} onRetry={onRetry} />,
    );
    expect(screen.getByLabelText("Loading report catalog").children).toHaveLength(8);
    rerender(
      <ReportCatalog
        entries={[]}
        selected={null}
        onSelect={vi.fn()}
        loading={false}
        error="Server error"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load the report catalog. Server error");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });
});
