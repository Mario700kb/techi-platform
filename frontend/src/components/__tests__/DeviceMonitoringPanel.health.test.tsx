import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DeviceMonitoringPanel from "../DeviceMonitoringPanel";
import { appCache } from "../../store/appCache";
import { metrics233Fixture, metricsFixture, monitoring233Fixture, monitoringFixture } from "./monitoringFixtures";

const getMetrics = vi.fn();
const getMonitoring = vi.fn();

vi.mock("../../api/monitoring", async (importActual) => ({
  ...(await importActual<typeof import("../../api/monitoring")>()),
  getDeviceMetrics: (...a: unknown[]) => getMetrics(...a),
  getDeviceMonitoring: (...a: unknown[]) => getMonitoring(...a),
}));

describe("DeviceMonitoringPanel with agent 2.1.33", () => {
  beforeEach(() => {
    appCache.invalidate();
    vi.useRealTimers();
    getMetrics.mockReset().mockResolvedValue(metrics233Fixture());
    getMonitoring.mockReset().mockResolvedValue(monitoring233Fixture());
  });

  it("shows availability with the restart, and marks restarts and alerts on the charts", async () => {
    render(<DeviceMonitoringPanel deviceId={7} active />);
    const availability = await screen.findByRole("region", { name: "Availability" });
    expect(within(availability).getByTestId("availability-strip").querySelectorAll("[data-kind]")).toHaveLength(6);
    expect(within(availability).getAllByTestId("availability-restart")).toHaveLength(1);
    expect(within(availability).getByText(/1 restart · last/)).toBeInTheDocument();
    expect(within(availability).getByText("2 h")).toBeInTheDocument(); // off

    const cpu = screen.getByRole("img", { name: "CPU usage over time" });
    expect(cpu.querySelectorAll('[data-testid="chart-marker"]')).toHaveLength(1);
    expect(cpu.querySelectorAll('[data-testid="chart-alert-band"]')).toHaveLength(1);
    expect(cpu.querySelector('[data-testid="chart-alert-band"] title')).toHaveTextContent(
      "Alert #91: CPU above 95% for 15 min on NW-RECEPTION-01",
    );
    // The memory chart has the restart but not the CPU alert.
    const mem = screen.getByRole("img", { name: "Memory used over time" });
    expect(mem.querySelectorAll('[data-testid="chart-alert-band"]')).toHaveLength(0);
    expect(mem.querySelectorAll('[data-testid="chart-marker"]')).toHaveLength(1);
  });

  it("draws disk activity and network quality, and names the busiest processes", async () => {
    render(<DeviceMonitoringPanel deviceId={7} active />);
    expect(await screen.findByRole("img", { name: "Disk busy time over time" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Disk read and write over time" })).toBeInTheDocument();
    expect(screen.getByText(/busy avg 12% · peak 97% · read peak 52.0 MB\/s/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Latency to the gateway and the platform over time" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Packet loss to the gateway over time" })).toBeInTheDocument();
    expect(screen.getByText("Gateway 2.9 ms")).toBeInTheDocument();
    expect(screen.getByText("Platform 31 ms")).toBeInTheDocument();
    expect(screen.getByText("loss 0.1%")).toBeInTheDocument();

    const table = screen.getByTestId("top-processes");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0].textContent)).toEqual(["MsMpEng.exe", "chrome.exe"]);
    expect(within(rows[0]).getByText(/61%/)).toBeInTheDocument();
    expect(within(rows[1]).getByText("1.8 GB")).toBeInTheDocument();
  });

  it("lists physical disk health, a pending restart and critical events", async () => {
    render(<DeviceMonitoringPanel deviceId={7} active />);
    const disks = await screen.findByRole("region", { name: "Physical disk health" });
    const rows = within(disks).getAllByTestId("disk-health-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Healthy")).toBeInTheDocument();
    expect(
      within(rows[0]).getByText(/SSD · SATA · 466 GB · 34 °C · 3% worn · 338 days on · no errors/),
    ).toBeInTheDocument();
    expect(within(rows[1]).getByText("Failing")).toBeInTheDocument();
    expect(within(rows[1]).getByText("SMART predicts failure")).toBeInTheDocument();
    expect(within(rows[1]).getByLabelText("Running hot")).toBeInTheDocument();
    expect(within(disks).getByText("1 needs attention")).toBeInTheDocument();

    const system = screen.getByRole("region", { name: "System health" });
    expect(within(system).getByTestId("reboot-pending")).toHaveAttribute("data-pending", "true");
    expect(within(system).getByText("Restart pending")).toBeInTheDocument();
    expect(within(system).getByText(/Windows Update · since/)).toBeInTheDocument();
    const events = within(system).getAllByTestId("health-event");
    expect(events.map((e) => e.textContent)).toEqual([
      expect.stringContaining("Blue screen (stop error)"),
      expect.stringContaining("Bad block on a disk"),
    ]);
    expect(within(system).getByText("2 critical events · 7 days")).toBeInTheDocument();
  });

  it("says Off for a monitor switched off and keeps small volumes out of alerts", async () => {
    render(<DeviceMonitoringPanel deviceId={7} active />);
    const monitors = await screen.findByRole("region", { name: "Monitors" });
    const off = within(monitors).getByText("Network receive").closest("li")!;
    expect(off).toHaveAttribute("data-state", "off");
    expect(within(off).getByText("Off")).toBeInTheDocument();
    expect(within(monitors).getByText("Disk health")).toBeInTheDocument();
    const small = screen.getAllByTestId("disk-row")[2];
    expect(within(small).getByText("Small volume (under 5 GB) · shown, not alerted on")).toBeInTheDocument();
  });

  it("explains what an older agent cannot show", async () => {
    getMetrics.mockResolvedValue(metricsFixture());
    getMonitoring.mockResolvedValue(monitoringFixture(false));
    render(<DeviceMonitoringPanel deviceId={7} active />);
    const disks = await screen.findByRole("region", { name: "Physical disk health" });
    expect(within(disks).getByText(/Agent 2.1.33 reads disk health/)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Disk busy time over time" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("top-processes")).not.toBeInTheDocument();
  });

  it("shows the busiest processes of the hovered minute in the CPU tooltip", async () => {
    render(<DeviceMonitoringPanel deviceId={7} active />);
    const cpu = await screen.findByRole("img", { name: "CPU usage over time" });
    const overlay = cpu.querySelector("rect[fill='transparent']") as SVGRectElement;
    overlay.getBoundingClientRect = () => ({ left: 48, width: 426, top: 0, height: 132 }) as DOMRect;
    // point 200 of ~265 points (a day of 5-minute points with a 2-hour gap)
    const metrics = metrics233Fixture();
    const t0 = Date.parse(metrics.start);
    const t1 = Date.parse(metrics.end);
    const t = Date.parse(metrics.points[200].t);
    fireEvent.mouseMove(overlay, { clientX: 48 + ((t - t0) / (t1 - t0)) * 426 });
    const tip = await screen.findByTestId("tip-top");
    expect(tip).toHaveTextContent("MsMpEng.exe");
    expect(tip).toHaveTextContent("61%");
  });
});
